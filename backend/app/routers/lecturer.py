import logging

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import cache_get, cache_invalidate_prefix, cache_set
from app.core.database import get_db
from app.core.deps import CurrentUser, require_lecturer
from app.core.errors import ForbiddenError, NotFoundError
from app.schemas.academic import SubjectCreate, SubjectOut
from app.services import pdf_processing
from app.utils.db_helpers import execute, fetch_all, fetch_one

router = APIRouter(prefix="/api/lecturer", tags=["lecturer"], dependencies=[Depends(require_lecturer)])
logger = logging.getLogger("app.lecturer")

_LIST_TTL = 120  # seconds — short enough that stale reads are never a real problem


@router.get("/me")
async def my_profile(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_lecturer)):
    cache_key = f"lecturer:{user.id}:profile"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    row = await fetch_one(db, "select id, lecturer_id, full_name, email from lecturers where id = :id",
                           {"id": user.id})
    if not row:
        raise NotFoundError("Lecturer not found.")
    await cache_set(cache_key, row, ttl=_LIST_TTL)
    return row


@router.put("/me")
async def update_profile(payload: dict, db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(require_lecturer)):
    """Lecturer can edit own name/details; lecturer_id (login) is fixed."""
    await execute(
        db, "update lecturers set full_name = :name, email = :email where id = :id",
        {"name": payload.get("full_name"), "email": payload.get("email"), "id": user.id},
    )
    await db.commit()
    await cache_invalidate_prefix(f"lecturer:{user.id}:profile")
    return {"ok": True}


# ---------------------------------------------------------------------------
# "My" endpoints — only semesters/sections/subjects the lecturer already
# teaches. Used for day-to-day navigation once they have subjects.
# ---------------------------------------------------------------------------
@router.get("/semesters")
async def my_semesters(db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_lecturer)):
    """Lecturer only sees semesters/sections where they have subjects."""
    cache_key = f"lecturer:{user.id}:semesters"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(
        db,
        """select distinct sem.id, sem.name
           from semesters sem
           join sections sec on sec.semester_id = sem.id
           join subjects sub on sub.section_id = sec.id
           where sub.lecturer_id = :lid and sub.is_active
           order by sem.name""",
        {"lid": user.id},
    )
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


@router.get("/semesters/{semester_id}/sections")
async def my_sections(semester_id: str, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(require_lecturer)):
    cache_key = f"lecturer:{user.id}:sections:{semester_id}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(
        db,
        """select distinct sec.id, sec.name
           from sections sec
           join subjects sub on sub.section_id = sec.id
           where sec.semester_id = :sem and sub.lecturer_id = :lid and sub.is_active
           order by sec.name""",
        {"sem": semester_id, "lid": user.id},
    )
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


@router.get("/sections/{section_id}/subjects", response_model=list[SubjectOut])
async def my_subjects(section_id: str, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(require_lecturer)):
    cache_key = f"lecturer:{user.id}:subjects:{section_id}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(
        db,
        """select id, section_id, lecturer_id, name, description, is_active
           from subjects where section_id = :sec and lecturer_id = :lid and is_active
           order by name""",
        {"sec": section_id, "lid": user.id},
    )
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


# ---------------------------------------------------------------------------
# "Browse" endpoints — ALL semesters/sections in the system, regardless of
# whether this lecturer teaches there yet. This is how a lecturer finds a
# section to create their *first* subject in (or add another one later).
# Read-only, no ownership check needed since nothing is exposed except
# names.
# ---------------------------------------------------------------------------
@router.get("/browse/semesters")
async def browse_all_semesters(db: AsyncSession = Depends(get_db)):
    cache_key = "browse:semesters"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(db, "select id, name from semesters where is_active order by name")
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


@router.get("/browse/semesters/{semester_id}/sections")
async def browse_sections_in_semester(semester_id: str, db: AsyncSession = Depends(get_db)):
    cache_key = f"browse:sections:{semester_id}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(
        db, "select id, name from sections where semester_id = :sem order by name", {"sem": semester_id},
    )
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


@router.post("/subjects", response_model=SubjectOut, status_code=201)
async def create_subject(payload: SubjectCreate, db: AsyncSession = Depends(get_db),
                          user: CurrentUser = Depends(require_lecturer)):
    row = await fetch_one(
        db,
        """insert into subjects (section_id, lecturer_id, name, description)
           values (:sec, :lid, :name, :desc)
           returning id, section_id, lecturer_id, name, description, is_active""",
        {"sec": payload.section_id, "lid": user.id, "name": payload.name, "desc": payload.description},
    )
    await db.commit()
    # A brand-new subject changes what "my semesters/sections/subjects" looks
    # like for this lecturer — drop those cached lists so the new subject
    # shows up immediately instead of waiting out the TTL.
    await cache_invalidate_prefix(f"lecturer:{user.id}:semesters")
    await cache_invalidate_prefix(f"lecturer:{user.id}:sections")
    await cache_invalidate_prefix(f"lecturer:{user.id}:subjects:{payload.section_id}")
    return row


async def _assert_owns_subject(db: AsyncSession, subject_id: str, lecturer_id: str) -> None:
    row = await fetch_one(db, "select id from subjects where id = :id and lecturer_id = :lid",
                           {"id": subject_id, "lid": lecturer_id})
    if not row:
        raise ForbiddenError("You do not have access to this subject.")


@router.get("/subjects/{subject_id}/students")
async def subject_students(subject_id: str, db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(require_lecturer)):
    """Students are auto-derived by matching Semester+Section — never manually added."""
    await _assert_owns_subject(db, subject_id, user.id)
    cache_key = f"subject:{subject_id}:students"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(
        db,
        """select s.id, s.register_number, s.full_name
           from subject_students ss
           join students s on s.id = ss.student_id
           where ss.subject_id = :sid
           order by s.full_name""",
        {"sid": subject_id},
    )
    await cache_set(cache_key, rows, ttl=60)  # shorter TTL — roster can change as admin edits students
    return rows


@router.post("/subjects/{subject_id}/pdf")
async def upload_pdf(subject_id: str, file: UploadFile = File(...),
                      db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_lecturer)):
    await _assert_owns_subject(db, subject_id, user.id)
    content = await file.read()
    doc = await pdf_processing.ingest_pdf(
        db=db, subject_id=subject_id, lecturer_id=user.id,
        filename=file.filename, content=content,
    )
    await db.commit()
    return doc


@router.get("/subjects/{subject_id}/question-bank")
async def question_bank(subject_id: str, type: str | None = None, status: str | None = None,
                         db: AsyncSession = Depends(get_db), user: CurrentUser = Depends(require_lecturer)):
    """Lecturer's own question bank — never shared between lecturers."""
    query = """select id, type, prompt, difficulty, topic, status, source, usage_count
               from questions where lecturer_id = :lid"""
    params: dict = {"lid": user.id}
    if type:
        query += " and type = :type"
        params["type"] = type
    if status:
        query += " and status = :status"
        params["status"] = status
    query += " order by created_at desc limit 200"
    return await fetch_all(db, query, params)


@router.patch("/question-bank/{question_id}")
async def update_bank_question(question_id: str, payload: dict, db: AsyncSession = Depends(get_db),
                                user: CurrentUser = Depends(require_lecturer)):
    """Mark a bank question unusable/reusable (lecturer can view/delete/mark/reuse own bank)."""
    row = await fetch_one(db, "select id from questions where id = :id and lecturer_id = :lid",
                           {"id": question_id, "lid": user.id})
    if not row:
        raise NotFoundError("Question not found in your bank.")
    if "status" in payload:
        await execute(db, "update questions set status = :s where id = :id",
                       {"s": payload["status"], "id": question_id})
    if "is_reusable" in payload:
        await execute(db, "update questions set is_reusable = :r where id = :id",
                       {"r": payload["is_reusable"], "id": question_id})
    await db.commit()
    return {"ok": True}


@router.delete("/question-bank/{question_id}", status_code=204)
async def delete_bank_question(question_id: str, db: AsyncSession = Depends(get_db),
                                user: CurrentUser = Depends(require_lecturer)):
    await execute(db, "delete from questions where id = :id and lecturer_id = :lid",
                  {"id": question_id, "lid": user.id})
    await db.commit()