import json
import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import cache_get, cache_invalidate_prefix, cache_set
from app.core.database import get_db
from app.core.deps import require_admin
from app.core.security import hash_password
from app.schemas.academic import (
    LecturerCreate, LecturerOut, SectionCreate, SectionOut, SemesterCreate,
    SemesterOut, StudentBulkCreate, StudentCreate, StudentOut,
)
from app.utils.db_helpers import execute, fetch_all, fetch_one

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])
logger = logging.getLogger("app.admin")

_LIST_TTL = 120  # seconds — admin lists change rarely; short TTL keeps writes visible fast


# ---------------------------------------------------------------- semesters
@router.post("/semesters", response_model=SemesterOut, status_code=201)
async def create_semester(payload: SemesterCreate, db: AsyncSession = Depends(get_db)):
    row = await fetch_one(
        db,
        "insert into semesters (name) values (:name) returning id, name, is_active",
        {"name": payload.name},
    )
    await db.commit()
    # Also drop the lecturer "browse" cache — it's the same underlying data,
    # just read through a different endpoint (see routers/lecturer.py).
    await cache_invalidate_prefix("admin:semesters")
    await cache_invalidate_prefix("browse:semesters")
    return row


@router.get("/semesters", response_model=list[SemesterOut])
async def list_semesters(db: AsyncSession = Depends(get_db)):
    cache_key = "admin:semesters"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(db, "select id, name, is_active from semesters order by created_at desc")
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


# ----------------------------------------------------------------- sections
@router.post("/sections", response_model=SectionOut, status_code=201)
async def create_section(payload: SectionCreate, db: AsyncSession = Depends(get_db)):
    row = await fetch_one(
        db,
        """insert into sections (semester_id, name) values (:sem, :name)
           returning id, semester_id, name""",
        {"sem": payload.semester_id, "name": payload.name},
    )
    await db.commit()
    await cache_invalidate_prefix("admin:sections")
    await cache_invalidate_prefix(f"browse:sections:{payload.semester_id}")
    return row


@router.get("/sections", response_model=list[SectionOut])
async def list_sections(semester_id: str | None = None, db: AsyncSession = Depends(get_db)):
    cache_key = f"admin:sections:{semester_id or 'all'}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    if semester_id:
        rows = await fetch_all(
            db, "select id, semester_id, name from sections where semester_id = :s order by name",
            {"s": semester_id},
        )
    else:
        rows = await fetch_all(db, "select id, semester_id, name from sections order by name")
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


# ---------------------------------------------------------------- lecturers
@router.post("/lecturers", response_model=LecturerOut, status_code=201)
async def create_lecturer(payload: LecturerCreate, db: AsyncSession = Depends(get_db)):
    row = await fetch_one(
        db,
        """insert into lecturers (lecturer_id, password_hash, full_name, email)
           values (:lid, :ph, :name, :email)
           returning id, lecturer_id, full_name, email, is_active""",
        {"lid": payload.lecturer_id, "ph": hash_password(payload.password),
         "name": payload.full_name, "email": payload.email},
    )
    await db.commit()
    await cache_invalidate_prefix("admin:lecturers")
    logger.info("lecturer_created", extra={"lecturer_id": payload.lecturer_id})
    return row


@router.get("/lecturers", response_model=list[LecturerOut])
async def list_lecturers(db: AsyncSession = Depends(get_db)):
    cache_key = "admin:lecturers"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(
        db, "select id, lecturer_id, full_name, email, is_active from lecturers order by full_name"
    )
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


@router.delete("/lecturers/{lecturer_id}", status_code=204)
async def delete_lecturer(lecturer_id: str, db: AsyncSession = Depends(get_db)):
    await execute(db, "update lecturers set is_active = false where id = :id", {"id": lecturer_id})
    await db.commit()
    await cache_invalidate_prefix("admin:lecturers")


# ----------------------------------------------------------------- students
@router.post("/students", response_model=StudentOut, status_code=201)
async def create_student(payload: StudentCreate, db: AsyncSession = Depends(get_db)):
    row = await fetch_one(
        db,
        """insert into students (register_number, password_hash, full_name,
               current_semester_id, current_section_id)
           values (:reg, :ph, :name, :sem, :sec)
           returning id, register_number, full_name, current_semester_id as semester_id,
                     current_section_id as section_id, is_active""",
        {"reg": payload.register_number, "ph": hash_password(payload.password),
         "name": payload.full_name, "sem": payload.semester_id, "sec": payload.section_id},
    )
    await db.commit()
    await cache_invalidate_prefix("admin:students")
    await cache_invalidate_prefix(f"subject:")  # a new student can change subject rosters
    return row


@router.post("/students/bulk", response_model=list[StudentOut], status_code=201)
async def bulk_create_students(payload: StudentBulkCreate, db: AsyncSession = Depends(get_db)):
    created = []
    for s in payload.students:
        row = await fetch_one(
            db,
            """insert into students (register_number, password_hash, full_name,
                   current_semester_id, current_section_id)
               values (:reg, :ph, :name, :sem, :sec)
               on conflict (register_number) do nothing
               returning id, register_number, full_name, current_semester_id as semester_id,
                         current_section_id as section_id, is_active""",
            {"reg": s.register_number, "ph": hash_password(s.password),
             "name": s.full_name, "sem": s.semester_id, "sec": s.section_id},
        )
        if row:
            created.append(row)
    await db.commit()
    await cache_invalidate_prefix("admin:students")
    await cache_invalidate_prefix("subject:")
    logger.info("students_bulk_created", extra={"count": len(created), "requested": len(payload.students)})
    return created


@router.get("/students", response_model=list[StudentOut])
async def list_students(
    semester_id: str | None = None, section_id: str | None = None,
    limit: int = 50, offset: int = 0, db: AsyncSession = Depends(get_db),
):
    cache_key = f"admin:students:{semester_id or '-'}:{section_id or '-'}:{limit}:{offset}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    query = """select id, register_number, full_name, current_semester_id as semester_id,
                      current_section_id as section_id, is_active
               from students where 1=1"""
    params: dict = {"limit": limit, "offset": offset}
    if semester_id:
        query += " and current_semester_id = :sem"
        params["sem"] = semester_id
    if section_id:
        query += " and current_section_id = :sec"
        params["sec"] = section_id
    query += " order by full_name limit :limit offset :offset"
    rows = await fetch_all(db, query, params)
    await cache_set(cache_key, rows, ttl=_LIST_TTL)
    return rows


@router.delete("/students/{student_id}", status_code=204)
async def delete_student(student_id: str, db: AsyncSession = Depends(get_db)):
    await execute(db, "update students set is_active = false where id = :id", {"id": student_id})
    await db.commit()
    await cache_invalidate_prefix("admin:students")
    await cache_invalidate_prefix("subject:")


# ---------------------------------------------------------- system settings
@router.get("/settings")
async def get_settings_all(db: AsyncSession = Depends(get_db)):
    cache_key = "admin:settings"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    rows = await fetch_all(db, "select key, value from system_settings")
    result = {r["key"]: r["value"] for r in rows}
    await cache_set(cache_key, result, ttl=_LIST_TTL)
    return result


@router.put("/settings/{key}")
async def update_setting(key: str, value: dict, db: AsyncSession = Depends(get_db)):
    await execute(
        db,
        "update system_settings set value = :v, updated_at = now() where key = :k",
        {"v": json.dumps(value.get("value")), "k": key},
    )
    await db.commit()
    await cache_invalidate_prefix("admin:settings")
    return {"ok": True}


# --------------------------------------------------------------- analytics
@router.get("/analytics/overview")
async def system_overview(db: AsyncSession = Depends(get_db)):
    """System-level analytics: AI/API usage, generated-question counts, active users, errors."""
    cache_key = "admin:analytics:overview"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached
    counts = await fetch_one(
        db,
        """select
             (select count(*) from students where is_active) as active_students,
             (select count(*) from lecturers where is_active) as active_lecturers,
             (select count(*) from assignments) as total_assignments,
             (select count(*) from questions where source = 'ai') as ai_generated_questions,
             (select count(*) from ai_usage_logs where status = 'failed') as ai_failures,
             (select count(*) from ai_usage_logs) as ai_calls_total
        """,
    )
    # Short TTL — this is a live-feeling dashboard number, not static config.
    await cache_set(cache_key, counts, ttl=30)
    return counts