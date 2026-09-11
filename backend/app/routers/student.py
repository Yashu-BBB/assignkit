import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import cache_get, cache_invalidate_prefix, cache_set
from app.core.config import get_settings
from app.core.database import get_db
from app.core.deps import CurrentUser, require_student
from app.core.errors import (AssignmentUnavailableError, ConflictError, DeadlinePassedError,
                              ForbiddenError, NotFoundError)
from app.schemas.assignment import AnswerSubmit, CodingCheckRequest
from app.services import evaluation, sandbox_client
from app.utils.db_helpers import execute, fetch_all, fetch_one

router = APIRouter(prefix="/api/student", tags=["student"], dependencies=[Depends(require_student)])
logger = logging.getLogger("app.student")
settings = get_settings()


@router.get("/me")
async def my_profile(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_student)):
    row = await fetch_one(
        db,
        """select id, register_number, full_name, current_semester_id, current_section_id
           from students where id = :id""",
        {"id": user.id},
    )
    if not row:
        raise NotFoundError("Student not found.")
    return row


@router.get("/subjects")
async def my_subjects(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_student)):
    """Student sees only subjects for their current Semester + Section."""
    cache_key = f"student:{user.id}:subjects"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(
        db,
        """select sub.id, sub.name, sub.description, l.full_name as lecturer_name
           from subject_students ss
           join subjects sub on sub.id = ss.subject_id
           join lecturers l on l.id = sub.lecturer_id
           where ss.student_id = :sid
           order by sub.name""",
        {"sid": user.id},
    )
    await cache_set(cache_key, rows, ttl=120)
    return rows


@router.get("/subjects/{subject_id}/assignments")
async def subject_assignments(subject_id: str, db: AsyncSession = Depends(get_db),
                               user: CurrentUser = Depends(require_student)):
    membership = await fetch_one(db, "select 1 from subject_students where subject_id = :sub and student_id = :sid",
                                  {"sub": subject_id, "sid": user.id})
    if not membership:
        raise ForbiddenError("You are not enrolled in this subject.")

    # Short TTL: this list includes the student's own live attempt status
    # (not_started/in_progress/submitted), so it can't be cached as long as
    # static lists — 15s keeps repeated page loads cheap without showing a
    # stale status right after the student submits something.
    cache_key = f"student:{user.id}:subject:{subject_id}:assignments"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    rows = await fetch_all(
        db,
        """select a.id, a.title, a.mode, a.status, a.start_at, a.deadline_at,
                  coalesce(sai.status, 'not_started') as my_status
           from assignments a
           left join student_assignment_instances sai
             on sai.assignment_id = a.id and sai.student_id = :sid
           where a.subject_id = :sub and a.status in ('scheduled','active','closed','archived')
           order by a.start_at desc""",
        {"sub": subject_id, "sid": user.id},
    )
    await cache_set(cache_key, rows, ttl=15)
    return rows


@router.post("/assignments/{assignment_id}/start")
async def start_assignment(assignment_id: str, db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(require_student)):
    """Begins (or resumes) the student's single attempt. Server enforces timing, not the client."""
    assignment = await fetch_one(db, "select * from assignments where id = :id", {"id": assignment_id})
    if not assignment:
        raise NotFoundError("Assignment not found.")

    now = datetime.now(timezone.utc)
    if now < assignment["start_at"]:
        raise AssignmentUnavailableError("This assignment has not started yet.")
    if now > assignment["deadline_at"]:
        raise DeadlinePassedError("The deadline for this assignment has passed.")

    instance = await fetch_one(
        db, "select * from student_assignment_instances where assignment_id = :aid and student_id = :sid",
        {"aid": assignment_id, "sid": user.id},
    )
    if not instance:
        raise NotFoundError("No question set has been assigned to you for this assignment.")
    if instance["status"] == "submitted":
        raise ConflictError("You have already submitted this assignment.", code="already_submitted")

    if instance["status"] == "not_started":
        await execute(
            db,
            "update student_assignment_instances set status = 'in_progress', started_at = now() where id = :id",
            {"id": instance["id"]},
        )
        question_ids = json.loads(instance["question_order"])
        for pos, qid in enumerate(question_ids):
            q = await fetch_one(db, "select type from questions where id = :id", {"id": qid})
            timer = assignment["timer_seconds_default"] if q["type"] in ("mcq", "short_answer") else None
            await execute(
                db,
                """insert into student_question_instances (instance_id, question_id, position, timer_seconds)
                   values (:iid, :qid, :pos, :timer)
                   on conflict (instance_id, question_id) do nothing""",
                {"iid": instance["id"], "qid": qid, "pos": pos, "timer": timer},
            )
        await db.commit()
        await cache_invalidate_prefix(f"student:{user.id}:subject:{assignment['subject_id']}:assignments")

    return await _build_attempt_view(db, instance["id"])


async def _build_attempt_view(db: AsyncSession, instance_id: str) -> dict:
    instance = await fetch_one(db, "select * from student_assignment_instances where id = :id", {"id": instance_id})
    sqis = await fetch_all(
        db,
        """select sqi.id as student_question_id, sqi.position, sqi.timer_seconds, sqi.time_started_at,
                  q.id as question_id, q.type, q.prompt, q.coding_language, q.expected_behavior,
                  q.constraints_text
           from student_question_instances sqi
           join questions q on q.id = sqi.question_id
           where sqi.instance_id = :iid order by sqi.position""",
        {"iid": instance_id},
    )
    for item in sqis:
        if item["type"] == "mcq":
            item["options"] = await fetch_all(
                db, "select id, option_text from question_options where question_id = :qid order by option_order",
                {"qid": item["question_id"]},
            )
        elif item["type"] == "coding":
            item["sample_test_cases"] = await fetch_all(
                db, "select input_data, expected_output from coding_test_cases "
                    "where question_id = :qid and is_sample = true",
                {"qid": item["question_id"]},
            )
    return {"instance": instance, "questions": sqis}


@router.post("/answers")
async def submit_answer(payload: AnswerSubmit, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_student)):
    """One Submit per question. Evaluated locally — no AI call per answer."""
    sqi = await fetch_one(
        db,
        """select sqi.*, sai.student_id, q.type from student_question_instances sqi
           join student_assignment_instances sai on sai.id = sqi.instance_id
           join questions q on q.id = sqi.question_id
           where sqi.id = :id""",
        {"id": payload.student_question_id},
    )
    if not sqi or sqi["student_id"] != user.id:
        raise NotFoundError("Question not found for this attempt.")

    existing = await fetch_one(db, "select id from answers where student_question_id = :id",
                                {"id": payload.student_question_id})
    if existing:
        raise ConflictError("This question has already been submitted.", code="already_submitted")

    if sqi["type"] == "mcq":
        correct_option = await fetch_one(
            db, "select id from question_options where question_id = :qid and is_correct = true",
            {"qid": sqi["question_id"]},
        )
        is_correct, score = evaluation.evaluate_mcq(payload.answer_text, correct_option["id"] if correct_option else "")
    elif sqi["type"] == "short_answer":
        accepted = await fetch_all(db, "select answer_text, match_type from accepted_answers where question_id = :qid",
                                    {"qid": sqi["question_id"]})
        is_correct, score = evaluation.evaluate_short_answer(payload.answer_text, accepted)
    else:
        raise ConflictError("Coding questions use the /coding/check and /coding/submit endpoints.")

    await execute(
        db,
        """insert into answers (student_question_id, answer_text, is_correct, score)
           values (:sqid, :text, :correct, :score)""",
        {"sqid": payload.student_question_id, "text": payload.answer_text, "correct": is_correct, "score": score},
    )
    await db.commit()
    logger.info("answer_submitted", extra={"student_id": user.id, "question_id": sqi["question_id"]})
    return {"is_correct": is_correct, "score": score}


@router.post("/coding/check")
async def coding_check(payload: CodingCheckRequest, db: AsyncSession = Depends(get_db),
                        user: CurrentUser = Depends(require_student)):
    """Non-final run against sample test cases only. Limited to CODING_MAX_CHECKS."""
    sqi = await fetch_one(
        db,
        """select sqi.*, sai.student_id from student_question_instances sqi
           join student_assignment_instances sai on sai.id = sqi.instance_id
           where sqi.id = :id""",
        {"id": payload.student_question_id},
    )
    if not sqi or sqi["student_id"] != user.id:
        raise NotFoundError("Question not found for this attempt.")

    check_count = await fetch_one(
        db, "select count(*) as n from coding_submissions where student_question_id = :id and is_final = false",
        {"id": payload.student_question_id},
    )
    if check_count["n"] >= settings.CODING_MAX_CHECKS:
        raise ConflictError(f"Maximum of {settings.CODING_MAX_CHECKS} checks reached.", code="check_limit_reached")

    sample_cases = await fetch_all(
        db, "select input_data as input, expected_output, true as is_sample "
            "from coding_test_cases where question_id = :qid and is_sample = true",
        {"qid": sqi["question_id"]},
    )
    result = await sandbox_client.evaluate_against_test_cases(
        code=payload.code, language=payload.language, test_cases=sample_cases,
    )
    await execute(
        db,
        """insert into coding_submissions (student_question_id, code, language, is_final, check_number,
               passed_test_cases, total_test_cases, status)
           values (:sqid, :code, :lang, false, :cn, :passed, :total, 'passed')""",
        {"sqid": payload.student_question_id, "code": payload.code, "lang": payload.language,
         "cn": check_count["n"] + 1, "passed": result["passed"], "total": result["total"]},
    )
    await db.commit()
    return result


@router.post("/coding/submit")
async def coding_submit(payload: CodingCheckRequest, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(require_student)):
    """Final submission — runs against ALL test cases (sample + hidden) and scores the question."""
    sqi = await fetch_one(
        db,
        """select sqi.*, sai.student_id from student_question_instances sqi
           join student_assignment_instances sai on sai.id = sqi.instance_id
           where sqi.id = :id""",
        {"id": payload.student_question_id},
    )
    if not sqi or sqi["student_id"] != user.id:
        raise NotFoundError("Question not found for this attempt.")

    already_final = await fetch_one(
        db, "select id from coding_submissions where student_question_id = :id and is_final = true",
        {"id": payload.student_question_id},
    )
    if already_final:
        raise ConflictError("This coding question has already been submitted.", code="already_submitted")

    all_cases = await fetch_all(
        db, "select input_data as input, expected_output, is_sample from coding_test_cases where question_id = :qid",
        {"qid": sqi["question_id"]},
    )
    result = await sandbox_client.evaluate_against_test_cases(
        code=payload.code, language=payload.language, test_cases=all_cases,
    )
    score = result["passed"] / result["total"] if result["total"] else 0

    await execute(
        db,
        """insert into coding_submissions (student_question_id, code, language, is_final,
               passed_test_cases, total_test_cases, score, status)
           values (:sqid, :code, :lang, true, :passed, :total, :score, 'passed')""",
        {"sqid": payload.student_question_id, "code": payload.code, "lang": payload.language,
         "passed": result["passed"], "total": result["total"], "score": score},
    )
    await db.commit()
    logger.info("coding_submitted", extra={"student_id": user.id, "question_id": sqi["question_id"], "score": score})
    return {"score": score, "passed": result["passed"], "total": result["total"],
            "results": [r for r in result["results"] if r["is_sample"]]}  # never reveal hidden case output


@router.post("/assignments/{assignment_id}/submit")
async def submit_assignment(assignment_id: str, db: AsyncSession = Depends(get_db),
                             user: CurrentUser = Depends(require_student)):
    """Finalizes the attempt, computing and caching the total score."""
    instance = await fetch_one(
        db, "select * from student_assignment_instances where assignment_id = :aid and student_id = :sid",
        {"aid": assignment_id, "sid": user.id},
    )
    if not instance:
        raise NotFoundError("Attempt not found.")
    if instance["status"] == "submitted":
        raise ConflictError("Already submitted.", code="already_submitted")

    mcq_sa_scores = await fetch_one(
        db,
        """select coalesce(sum(a.score),0) as total, count(*) as n
           from answers a join student_question_instances sqi on sqi.id = a.student_question_id
           where sqi.instance_id = :iid""",
        {"iid": instance["id"]},
    )
    coding_scores = await fetch_one(
        db,
        """select coalesce(sum(cs.score),0) as total, count(*) as n
           from coding_submissions cs join student_question_instances sqi on sqi.id = cs.student_question_id
           where sqi.instance_id = :iid and cs.is_final = true""",
        {"iid": instance["id"]},
    )
    total_questions = await fetch_one(
        db, "select count(*) as n from student_question_instances where instance_id = :iid", {"iid": instance["id"]},
    )
    total_score = float(mcq_sa_scores["total"]) + float(coding_scores["total"])
    max_score = float(total_questions["n"])
    time_taken = None
    if instance["started_at"]:
        time_taken = int((datetime.now(timezone.utc) - instance["started_at"]).total_seconds())

    await execute(
        db,
        """update student_assignment_instances
           set status = 'submitted', submitted_at = now(), total_score = :score, max_score = :max
           where id = :id""",
        {"score": total_score, "max": max_score, "id": instance["id"]},
    )
    await execute(
        db,
        """insert into assignment_results (instance_id, assignment_id, student_id, total_score, max_score,
               time_taken_seconds)
           values (:iid, :aid, :sid, :score, :max, :time)
           on conflict (instance_id) do update set total_score = excluded.total_score,
               max_score = excluded.max_score, time_taken_seconds = excluded.time_taken_seconds,
               computed_at = now()""",
        {"iid": instance["id"], "aid": assignment_id, "sid": user.id, "score": total_score, "max": max_score,
         "time": time_taken},
    )
    await db.commit()
    subject_row = await fetch_one(db, "select subject_id from assignments where id = :id", {"id": assignment_id})
    if subject_row:
        await cache_invalidate_prefix(f"student:{user.id}:subject:{subject_row['subject_id']}:assignments")
    logger.info("assignment_submitted", extra={"student_id": user.id, "assignment_id": assignment_id,
                                                 "score": total_score, "max": max_score})
    return {"total_score": total_score, "max_score": max_score}


@router.post("/assignments/{assignment_id}/violations")
async def report_violation(assignment_id: str, payload: dict, db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(require_student)):
    """Client reports proctoring events (tab switch, blur, etc). Server is the record of truth for scoring;
    this only logs — it never itself changes the score."""
    instance = await fetch_one(
        db, "select id from student_assignment_instances where assignment_id = :aid and student_id = :sid",
        {"aid": assignment_id, "sid": user.id},
    )
    if not instance:
        raise NotFoundError("Attempt not found.")
    await execute(
        db, "insert into violations (instance_id, type, detail) values (:iid, :type, :detail)",
        {"iid": instance["id"], "type": payload.get("type", "other"), "detail": payload.get("detail")},
    )
    await db.commit()
    return {"ok": True}


@router.get("/assignments/{assignment_id}/result")
async def my_result(assignment_id: str, db: AsyncSession = Depends(get_db),
                     user: CurrentUser = Depends(require_student)):
    """Student analytics — own performance only, no class comparison (leaderboard is separate)."""
    assignment = await fetch_one(db, "select result_buffer_seconds, deadline_at from assignments where id = :id",
                                  {"id": assignment_id})
    result = await fetch_one(
        db, "select * from assignment_results where assignment_id = :aid and student_id = :sid",
        {"aid": assignment_id, "sid": user.id},
    )
    if not result:
        raise NotFoundError("No result available yet.")

    reveal_at = assignment["deadline_at"]
    now = datetime.now(timezone.utc)
    buffered_reveal = reveal_at.timestamp() + assignment["result_buffer_seconds"]
    if now.timestamp() < buffered_reveal:
        return {"status": "pending", "message": "Results are being finalized. Check back shortly."}
    return result