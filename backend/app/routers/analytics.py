from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import cache_get, cache_set
from app.core.database import get_db
from app.core.deps import CurrentUser, require_lecturer, require_student
from app.core.errors import ForbiddenError, NotFoundError
from app.utils.db_helpers import fetch_all, fetch_one

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


async def _assert_lecturer_owns_assignment(db: AsyncSession, assignment_id: str, lecturer_id: str) -> dict:
    row = await fetch_one(
        db,
        """select a.*, s.lecturer_id from assignments a
           join subjects s on s.id = a.subject_id where a.id = :id""",
        {"id": assignment_id},
    )
    if not row:
        raise NotFoundError("Assignment not found.")
    if row["lecturer_id"] != lecturer_id:
        raise ForbiddenError("You do not have access to this assignment.")
    return row


@router.get("/assignments/{assignment_id}/overview", dependencies=[Depends(require_lecturer)])
async def assignment_overview(assignment_id: str, db: AsyncSession = Depends(get_db),
                               user: CurrentUser = Depends(require_lecturer)):
    """Everything here is derived live from assignment_results / answers — no duplicated metrics table."""
    await _assert_lecturer_owns_assignment(db, assignment_id, user.id)

    cache_key = f"analytics:assignment:{assignment_id}:overview"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    summary = await fetch_one(
        db,
        """select count(*) as attempts, avg(percentage) as avg_percentage,
                  min(percentage) as min_percentage, max(percentage) as max_percentage
           from assignment_results where assignment_id = :aid""",
        {"aid": assignment_id},
    )
    per_question = await fetch_all(
        db,
        """select q.id as question_id, q.type, q.prompt,
                  count(a.id) filter (where a.is_correct) as correct_count,
                  count(a.id) as attempt_count
           from questions q
           join set_questions sq on sq.question_id = q.id
           join question_sets qs on qs.id = sq.question_set_id
           left join student_question_instances sqi on sqi.question_id = q.id
           left join answers a on a.student_question_id = sqi.id
           where qs.assignment_id = :aid
           group by q.id, q.type, q.prompt""",
        {"aid": assignment_id},
    )
    violations = await fetch_all(
        db,
        """select v.type, count(*) as count from violations v
           join student_assignment_instances sai on sai.id = v.instance_id
           where sai.assignment_id = :aid group by v.type""",
        {"aid": assignment_id},
    )

    payload = {"summary": summary, "per_question": per_question, "violations": violations}
    await cache_set(cache_key, payload, ttl=60)
    return payload


@router.get("/assignments/{assignment_id}/leaderboard")
async def leaderboard(assignment_id: str, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(require_student)):
    """Leaderboard IS the class comparison view (student analytics elsewhere is not)."""
    assignment = await fetch_one(db, "select deadline_at, result_buffer_seconds from assignments where id = :id",
                                  {"id": assignment_id})
    if not assignment:
        raise NotFoundError("Assignment not found.")

    reveal_at = assignment["deadline_at"].timestamp() + assignment["result_buffer_seconds"]
    if datetime.now(timezone.utc).timestamp() < reveal_at:
        return {"status": "pending", "message": "Leaderboard unlocks after the result buffer window."}

    return await fetch_all(
        db,
        """select rank, student_name, total_score, max_score, percentage, time_taken_seconds
           from leaderboard_view where assignment_id = :aid order by rank limit 100""",
        {"aid": assignment_id},
    )


@router.get("/subjects/{subject_id}/students/{student_id}", dependencies=[Depends(require_lecturer)])
async def student_performance_in_subject(subject_id: str, student_id: str, db: AsyncSession = Depends(get_db),
                                          user: CurrentUser = Depends(require_lecturer)):
    owns = await fetch_one(db, "select id from subjects where id = :id and lecturer_id = :lid",
                            {"id": subject_id, "lid": user.id})
    if not owns:
        raise ForbiddenError("You do not have access to this subject.")

    return await fetch_all(
        db,
        """select a.id as assignment_id, a.title, ar.percentage, ar.total_score, ar.max_score,
                  ar.time_taken_seconds, ar.computed_at
           from assignment_results ar
           join assignments a on a.id = ar.assignment_id
           where a.subject_id = :sub and ar.student_id = :sid
           order by a.created_at desc""",
        {"sub": subject_id, "sid": student_id},
    )
