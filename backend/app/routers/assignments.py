import logging

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import cache_invalidate_prefix
from app.core.database import get_db
from app.core.deps import CurrentUser, require_lecturer
from app.core.config import get_settings
from app.core.errors import FeatureUnavailableError, ForbiddenError, NotFoundError
from app.schemas.assignment import AssignmentCreate, AssignmentOut
from app.services import generation_pipeline
from app.utils.db_helpers import execute, fetch_all, fetch_one

router = APIRouter(prefix="/api/assignments", tags=["assignments"])
logger = logging.getLogger("app.assignments")


async def _assert_owns_subject(db: AsyncSession, subject_id: str, lecturer_id: str) -> None:
    row = await fetch_one(db, "select id from subjects where id = :id and lecturer_id = :lid",
                           {"id": subject_id, "lid": lecturer_id})
    if not row:
        raise ForbiddenError("You do not have access to this subject.")


@router.post("", response_model=AssignmentOut, status_code=201, dependencies=[Depends(require_lecturer)])
async def create_assignment(
    payload: AssignmentCreate, background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_lecturer),
):
    await _assert_owns_subject(db, payload.subject_id, user.id)

    # Writing coding questions by hand is switched off (FEATURE_MANUAL_CODING).
    # Enforced here as well as in the UI. AI-written coding questions in
    # AI/hybrid mode are a separate path and stay available.
    if not get_settings().FEATURE_MANUAL_CODING:
        if payload.manual_coding:
            raise FeatureUnavailableError(
                "Writing coding questions manually is temporarily unavailable."
            )
        if payload.mode == "manual" and payload.coding_count > 0:
            raise FeatureUnavailableError(
                "Manual mode can't include coding questions right now. Set the coding count to 0, "
                "or switch to Hybrid so the AI writes them."
            )

    max_sets_row = await fetch_one(db, "select value from system_settings where key = 'max_sets_per_assignment'")
    max_sets = int(max_sets_row["value"]) if max_sets_row else 20
    if payload.num_sets > max_sets:
        raise ForbiddenError(f"Number of sets cannot exceed the admin-configured maximum ({max_sets}).")

    row = await fetch_one(
        db,
        """insert into assignments (
             subject_id, source_document_id, title, mode, status,
             total_questions, mcq_count, short_answer_count, coding_count,
             num_sets, overall_difficulty, timer_seconds_default, start_at, deadline_at,
             result_buffer_seconds, general_ai_instructions, mcq_ai_instructions,
             short_answer_ai_instructions, coding_ai_instructions, created_by
           ) values (
             :subject_id, :source_document_id, :title, :mode, 'draft',
             :total_questions, :mcq_count, :short_answer_count, :coding_count,
             :num_sets, :overall_difficulty, :timer_seconds_default, :start_at, :deadline_at,
             :result_buffer_seconds, :general_ai_instructions, :mcq_ai_instructions,
             :short_answer_ai_instructions, :coding_ai_instructions, :created_by
           )
           returning id, subject_id, title, mode, status, total_questions, mcq_count,
                     short_answer_count, coding_count, num_sets, overall_difficulty,
                     start_at, deadline_at, created_at""",
        {
            "subject_id": payload.subject_id, "source_document_id": payload.source_document_id,
            "title": payload.title, "mode": payload.mode, "total_questions": payload.total_questions,
            "mcq_count": payload.mcq_count, "short_answer_count": payload.short_answer_count,
            "coding_count": payload.coding_count, "num_sets": payload.num_sets,
            "overall_difficulty": payload.overall_difficulty,
            "timer_seconds_default": payload.timer_seconds_default, "start_at": payload.start_at,
            "deadline_at": payload.deadline_at, "result_buffer_seconds": payload.result_buffer_seconds,
            "general_ai_instructions": payload.general_ai_instructions,
            "mcq_ai_instructions": payload.mcq_ai_instructions,
            "short_answer_ai_instructions": payload.short_answer_ai_instructions,
            "coding_ai_instructions": payload.coding_ai_instructions, "created_by": user.id,
        },
    )
    await db.commit()
    assignment_id = row["id"]

    # Manual questions are inserted synchronously (fast, no AI call).
    await generation_pipeline.insert_manual_questions(db, assignment_id=assignment_id, lecturer_id=user.id,
                                                        payload=payload)
    await db.commit()

    if payload.mode == "manual":
        # No AI needed — sets can be finalized immediately.
        await generation_pipeline.finalize_manual_only_sets(db, assignment_id=assignment_id,
                                                              num_sets=payload.num_sets)
        await db.commit()
    else:
        # AI/hybrid: run generation + validation in the background so the
        # request returns immediately; assignment stays 'generating' until done.
        await execute(db, "update assignments set status = 'generating' where id = :id",
                       {"id": assignment_id})
        await db.commit()
        background_tasks.add_task(generation_pipeline.run_ai_generation_job, assignment_id, user.id)

    await cache_invalidate_prefix(f"subject:{payload.subject_id}:assignments")
    logger.info("assignment_created", extra={"assignment_id": assignment_id, "mode": payload.mode})
    return row


@router.get("/subject/{subject_id}", response_model=list[AssignmentOut], dependencies=[Depends(require_lecturer)])
async def list_subject_assignments(subject_id: str, db: AsyncSession = Depends(get_db),
                                    user: CurrentUser = Depends(require_lecturer)):
    await _assert_owns_subject(db, subject_id, user.id)
    return await fetch_all(
        db,
        """select id, subject_id, title, mode, status, total_questions, mcq_count,
                  short_answer_count, coding_count, num_sets, overall_difficulty,
                  start_at, deadline_at, created_at
           from assignments where subject_id = :sid order by created_at desc""",
        {"sid": subject_id},
    )


@router.get("/{assignment_id}", dependencies=[Depends(require_lecturer)])
async def get_assignment(assignment_id: str, db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(require_lecturer)):
    row = await fetch_one(
        db,
        """select a.*, s.lecturer_id from assignments a
           join subjects s on s.id = a.subject_id where a.id = :id""",
        {"id": assignment_id},
    )
    if not row:
        raise NotFoundError("Assignment not found.")
    if row["lecturer_id"] != user.id:
        raise ForbiddenError("You do not have access to this assignment.")
    return row