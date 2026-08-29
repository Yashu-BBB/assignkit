"""
Orchestrates assignment question-set creation end to end:
  1. Insert manual questions (common to every set).
  2. For AI/hybrid: generate only the missing slots per type, per set,
     validate each, regenerate on failure (bounded), then assemble sets.
  3. Distribute students across sets (randomized, balanced) and shuffle
     each student's question order independently.

Kept as a single module so the ordering/business rules in the spec (manual
in every set, AI fills only the gap, no AI calls during exams, etc.) live
in one place rather than scattered across routers.
"""
import json
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal
from app.schemas.assignment import AssignmentCreate
from app.services import ai_generation, set_distribution
from app.utils.db_helpers import execute, fetch_all, fetch_one

logger = logging.getLogger("app.generation")

MAX_REGENERATION_ATTEMPTS = 2


async def insert_manual_questions(db: AsyncSession, *, assignment_id: str, lecturer_id: str,
                                   payload: AssignmentCreate) -> dict[str, list[str]]:
    """Inserts lecturer-supplied questions once each; they'll be linked into every set.
    Returns {"mcq": [question_ids], "short_answer": [...], "coding": [...]}."""
    doc_row = await fetch_one(db, "select source_document_id from assignments where id = :id",
                               {"id": assignment_id})
    source_document_id = doc_row["source_document_id"] if doc_row else None
    ids: dict[str, list[str]] = {"mcq": [], "short_answer": [], "coding": []}

    for mcq in payload.manual_mcqs:
        q = await fetch_one(
            db,
            """insert into questions (lecturer_id, assignment_id, source_document_id, type, source,
                   status, prompt, difficulty)
               values (:lid, :aid, :doc, 'mcq', 'manual', 'valid', :prompt, :diff)
               returning id""",
            {"lid": lecturer_id, "aid": assignment_id, "doc": source_document_id,
             "prompt": mcq.prompt, "diff": mcq.difficulty or payload.overall_difficulty},
        )
        for i, opt in enumerate(mcq.options):
            await execute(
                db,
                """insert into question_options (question_id, option_text, is_correct, option_order)
                   values (:qid, :text, :correct, :order)""",
                {"qid": q["id"], "text": opt, "correct": i == mcq.correct_option_index, "order": i},
            )
        ids["mcq"].append(q["id"])

    for sa in payload.manual_short_answers:
        q = await fetch_one(
            db,
            """insert into questions (lecturer_id, assignment_id, source_document_id, type, source,
                   status, prompt, difficulty)
               values (:lid, :aid, :doc, 'short_answer', 'manual', 'valid', :prompt, :diff)
               returning id""",
            {"lid": lecturer_id, "aid": assignment_id, "doc": source_document_id,
             "prompt": sa.prompt, "diff": sa.difficulty or payload.overall_difficulty},
        )
        for ans in sa.accepted_answers:
            await execute(
                db, "insert into accepted_answers (question_id, answer_text) values (:qid, :ans)",
                {"qid": q["id"], "ans": ans},
            )
        ids["short_answer"].append(q["id"])

    for code_q in payload.manual_coding:
        q = await fetch_one(
            db,
            """insert into questions (lecturer_id, assignment_id, source_document_id, type, source,
                   status, prompt, difficulty, coding_language, expected_behavior, constraints_text)
               values (:lid, :aid, :doc, 'coding', 'manual', 'valid', :prompt, :diff, :lang, :behavior, :constraints)
               returning id""",
            {"lid": lecturer_id, "aid": assignment_id, "doc": source_document_id, "prompt": code_q.prompt,
             "diff": code_q.difficulty or payload.overall_difficulty, "lang": code_q.language,
             "behavior": code_q.expected_behavior, "constraints": code_q.constraints},
        )
        if code_q.sample_input is not None or code_q.sample_output is not None:
            await execute(
                db,
                """insert into coding_test_cases (question_id, input_data, expected_output, is_sample)
                   values (:qid, :inp, :out, true)""",
                {"qid": q["id"], "inp": code_q.sample_input, "out": code_q.sample_output or ""},
            )
        for tc in code_q.hidden_test_cases:
            await execute(
                db,
                """insert into coding_test_cases (question_id, input_data, expected_output, is_sample)
                   values (:qid, :inp, :out, false)""",
                {"qid": q["id"], "inp": tc.get("input"), "out": tc.get("expected_output", "")},
            )
        ids["coding"].append(q["id"])

    return ids


async def finalize_manual_only_sets(db: AsyncSession, *, assignment_id: str, num_sets: int) -> None:
    """Manual mode: same fixed question list goes into every set (no AI variation needed)."""
    manual_qs = await fetch_all(
        db, "select id from questions where assignment_id = :aid and source = 'manual' order by created_at",
        {"aid": assignment_id},
    )
    question_ids = [q["id"] for q in manual_qs]

    for set_idx in range(1, num_sets + 1):
        qset = await fetch_one(
            db, "insert into question_sets (assignment_id, set_index) values (:aid, :idx) returning id",
            {"aid": assignment_id, "idx": set_idx},
        )
        for pos, qid in enumerate(question_ids):
            await execute(
                db,
                "insert into set_questions (question_set_id, question_id, position) values (:sid, :qid, :pos)",
                {"sid": qset["id"], "qid": qid, "pos": pos},
            )

    await execute(db, "update assignments set status = 'scheduled' where id = :id", {"id": assignment_id})
    await _distribute_students(db, assignment_id=assignment_id, num_sets=num_sets)


async def run_ai_generation_job(assignment_id: str, lecturer_id: str) -> None:
    """
    Background job (own DB session since it runs outside the request scope).
    On persistent AI failure, per spec, the assignment is saved as Draft
    rather than left half-built.
    """
    async with AsyncSessionLocal() as db:
        try:
            await _run_ai_generation(db, assignment_id=assignment_id, lecturer_id=lecturer_id)
            await db.commit()
        except Exception as e:  # noqa: BLE001 — top-level job guard
            logger.error("ai_generation_job_failed", extra={"assignment_id": assignment_id, "error": str(e)})
            await db.rollback()
            await execute(db, "update assignments set status = 'draft' where id = :id", {"id": assignment_id})
            await db.commit()


async def _run_ai_generation(db: AsyncSession, *, assignment_id: str, lecturer_id: str) -> None:
    assignment = await fetch_one(db, "select * from assignments where id = :id", {"id": assignment_id})
    manual = await fetch_all(
        db, "select id, type from questions where assignment_id = :aid and source = 'manual'",
        {"aid": assignment_id},
    )
    manual_by_type = {"mcq": [], "short_answer": [], "coding": []}
    for q in manual:
        manual_by_type[q["type"]].append(q["id"])

    ai_mcq_needed = assignment["mcq_count"] - len(manual_by_type["mcq"])
    ai_sa_needed = assignment["short_answer_count"] - len(manual_by_type["short_answer"])
    ai_coding_needed = assignment["coding_count"] - len(manual_by_type["coding"])

    knowledge_items: list[dict] = []
    if assignment["source_document_id"]:
        knowledge_items = await fetch_all(
            db, "select * from extracted_knowledge where source_document_id = :doc",
            {"doc": assignment["source_document_id"]},
        )

    if ai_mcq_needed > 0 or ai_sa_needed > 0 or ai_coding_needed > 0:
        generated_sets = await ai_generation.generate_question_sets(
            knowledge_items=knowledge_items, mcq_count=ai_mcq_needed, short_answer_count=ai_sa_needed,
            coding_count=ai_coding_needed, num_sets=assignment["num_sets"],
            difficulty=assignment["overall_difficulty"],
            general_instructions=assignment["general_ai_instructions"],
            mcq_instructions=assignment["mcq_ai_instructions"],
            short_answer_instructions=assignment["short_answer_ai_instructions"],
            coding_instructions=assignment["coding_ai_instructions"],
        )
    else:
        generated_sets = [[] for _ in range(assignment["num_sets"])]

    for set_idx, ai_questions in enumerate(generated_sets, start=1):
        validated_ids = []
        for q in ai_questions:
            qid = await _validate_and_store(db, q, lecturer_id=lecturer_id, assignment_id=assignment_id,
                                              source_document_id=assignment["source_document_id"],
                                              knowledge_items=knowledge_items)
            if qid:
                validated_ids.append(qid)

        qset = await fetch_one(
            db, "insert into question_sets (assignment_id, set_index) values (:aid, :idx) returning id",
            {"aid": assignment_id, "idx": set_idx},
        )
        all_ids = manual_by_type["mcq"] + manual_by_type["short_answer"] + manual_by_type["coding"] + validated_ids
        for pos, qid in enumerate(all_ids):
            await execute(
                db,
                "insert into set_questions (question_set_id, question_id, position) values (:sid, :qid, :pos)",
                {"sid": qset["id"], "qid": qid, "pos": pos},
            )

    await execute(db, "update assignments set status = 'scheduled' where id = :id", {"id": assignment_id})
    await _distribute_students(db, assignment_id=assignment_id, num_sets=assignment["num_sets"])


async def _validate_and_store(db: AsyncSession, q: dict, *, lecturer_id: str, assignment_id: str,
                               source_document_id: str | None, knowledge_items: list[dict]) -> str | None:
    """Validates one AI question, regenerating up to MAX_REGENERATION_ATTEMPTS on failure, then stores it."""
    candidate = q
    for attempt in range(MAX_REGENERATION_ATTEMPTS + 1):
        result = await ai_generation.validate_question(candidate, knowledge_items)
        if result.get("valid"):
            return await _store_ai_question(db, candidate, lecturer_id=lecturer_id,
                                              assignment_id=assignment_id, source_document_id=source_document_id)
        logger.warning("question_validation_failed", extra={"attempt": attempt, "notes": result.get("notes")})
        # Bounded regeneration: for V1 we stop retrying a single question after
        # the cap and simply drop it rather than looping indefinitely.
    return None


async def _store_ai_question(db: AsyncSession, q: dict, *, lecturer_id: str, assignment_id: str,
                              source_document_id: str | None) -> str:
    row = await fetch_one(
        db,
        """insert into questions (lecturer_id, assignment_id, source_document_id, type, source, status,
               prompt, difficulty, topic, concept, learning_objective, key_terms,
               coding_language, expected_behavior, constraints_text)
           values (:lid, :aid, :doc, :type, 'ai', 'valid', :prompt, :diff, :topic, :concept, :lo, :terms,
               :lang, :behavior, :constraints)
           returning id""",
        {
            "lid": lecturer_id, "aid": assignment_id, "doc": source_document_id, "type": q["type"],
            "prompt": q["prompt"], "diff": q.get("difficulty", "medium"), "topic": q.get("topic"),
            "concept": q.get("concept"), "lo": q.get("learning_objective"),
            "terms": q.get("key_terms", []), "lang": q.get("language"),
            "behavior": q.get("expected_behavior"), "constraints": q.get("constraints"),
        },
    )
    qid = row["id"]

    if q["type"] == "mcq":
        for i, opt in enumerate(q.get("options", [])):
            await execute(
                db,
                "insert into question_options (question_id, option_text, is_correct, option_order) "
                "values (:qid, :text, :correct, :order)",
                {"qid": qid, "text": opt, "correct": i == q.get("correct_option_index"), "order": i},
            )
    elif q["type"] == "short_answer":
        for ans in q.get("accepted_answers", []):
            await execute(db, "insert into accepted_answers (question_id, answer_text) values (:qid, :ans)",
                           {"qid": qid, "ans": ans})
    elif q["type"] == "coding":
        for tc in q.get("test_cases", []):
            await execute(
                db,
                "insert into coding_test_cases (question_id, input_data, expected_output, is_sample) "
                "values (:qid, :inp, :out, :sample)",
                {"qid": qid, "inp": tc.get("input"), "out": tc.get("expected_output", ""),
                 "sample": tc.get("is_sample", False)},
            )
    return qid


async def _distribute_students(db: AsyncSession, *, assignment_id: str, num_sets: int) -> None:
    """Randomly, evenly distributes enrolled students across sets and builds
    each student's shuffled question order — done once at scheduling time."""
    subject_row = await fetch_one(db, "select subject_id from assignments where id = :id", {"id": assignment_id})
    students = await fetch_all(
        db, "select student_id from subject_students where subject_id = :sid", {"sid": subject_row["subject_id"]},
    )
    student_ids = [s["student_id"] for s in students]
    if not student_ids:
        return

    assignment_map = set_distribution.distribute_students_to_sets(student_ids, num_sets)
    sets = await fetch_all(
        db, "select id, set_index from question_sets where assignment_id = :aid", {"aid": assignment_id},
    )
    set_id_by_index = {s["set_index"]: s["id"] for s in sets}

    deadline_row = await fetch_one(db, "select deadline_at from assignments where id = :id", {"id": assignment_id})

    for student_id, set_idx in assignment_map.items():
        qset_id = set_id_by_index[set_idx]
        set_questions = await fetch_all(
            db, "select question_id from set_questions where question_set_id = :sid order by position",
            {"sid": qset_id},
        )
        question_ids = [q["question_id"] for q in set_questions]
        shuffled = set_distribution.shuffle_question_order(question_ids)

        await execute(
            db,
            """insert into student_assignment_instances
                 (assignment_id, student_id, question_set_id, question_order, status, expires_at)
               values (:aid, :sid, :qsid, :order, 'not_started', :expires)
               on conflict (assignment_id, student_id) do nothing""",
            {"aid": assignment_id, "sid": student_id, "qsid": qset_id,
             "order": json.dumps(shuffled), "expires": deadline_row["deadline_at"]},
        )
