"""
Thin helpers around SQLAlchemy's async engine for parameterized raw SQL.
All queries use bound parameters (:name) — never string-formatted SQL —
which is our SQL-injection defense (per spec section 28).

Every row is passed through _serialize_row before it reaches a router, so
UUID columns come back as plain strings everywhere in the app. Without
this, FastAPI's response models (which declare ids as `str`) reject the
raw UUID objects asyncpg returns, with a ResponseValidationError. Fixing
it once here means no individual router or schema ever has to remember
to call str(...) on an id field.
"""
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def _serialize_row(row: dict) -> dict:
    return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in row.items()}


async def fetch_one(db: AsyncSession, query: str, params: dict[str, Any] | None = None) -> dict | None:
    result = await db.execute(text(query), params or {})
    row = result.mappings().first()
    return _serialize_row(dict(row)) if row else None


async def fetch_all(db: AsyncSession, query: str, params: dict[str, Any] | None = None) -> list[dict]:
    result = await db.execute(text(query), params or {})
    return [_serialize_row(dict(r)) for r in result.mappings().all()]


async def execute(db: AsyncSession, query: str, params: dict[str, Any] | None = None) -> None:
    await db.execute(text(query), params or {})