import io
import logging

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, require_lecturer
from app.core.errors import ForbiddenError, NotFoundError
from app.utils.db_helpers import fetch_all, fetch_one

router = APIRouter(prefix="/api/archive", tags=["archive"], dependencies=[Depends(require_lecturer)])
logger = logging.getLogger("app.archive")


@router.get("/assignments/{assignment_id}.xlsx")
async def export_assignment_results(assignment_id: str, db: AsyncSession = Depends(get_db),
                                     user: CurrentUser = Depends(require_lecturer)):
    """Archive is Excel-only in V1 (spec section 30)."""
    assignment = await fetch_one(
        db,
        """select a.title, s.lecturer_id from assignments a
           join subjects s on s.id = a.subject_id where a.id = :id""",
        {"id": assignment_id},
    )
    if not assignment:
        raise NotFoundError("Assignment not found.")
    if assignment["lecturer_id"] != user.id:
        raise ForbiddenError("You do not have access to this assignment.")

    rows = await fetch_all(
        db,
        """select s.register_number, s.full_name, ar.total_score, ar.max_score, ar.percentage,
                  ar.time_taken_seconds, ar.computed_at
           from assignment_results ar
           join students s on s.id = ar.student_id
           where ar.assignment_id = :aid
           order by ar.percentage desc""",
        {"aid": assignment_id},
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "Results"
    headers = ["Register Number", "Name", "Score", "Max Score", "Percentage", "Time Taken (s)", "Computed At"]
    ws.append(headers)
    for r in rows:
        ws.append([r["register_number"], r["full_name"], r["total_score"], r["max_score"],
                   r["percentage"], r["time_taken_seconds"], str(r["computed_at"])])
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 18

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    logger.info("archive_generated", extra={"assignment_id": assignment_id, "rows": len(rows)})
    filename = f"{assignment['title'].replace(' ', '_')}_results.xlsx"
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
