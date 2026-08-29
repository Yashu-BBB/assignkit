"""
Thin helpers around SQLAlchemy's async engine for parameterized raw SQL.
All queries use bound parameters (:name) — never string-formatted SQL —
which is our SQL-injection defense (per spec section 28).
"""
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def fetch_one(db: AsyncSession, query: str, params: dict[str, Any] | None = None) -> dict | None:
    result = await db.execute(text(query), params or {})
    row = result.mappings().first()
    return dict(row) if row else None


async def fetch_all(db: AsyncSession, query: str, params: dict[str, Any] | None = None) -> list[dict]:
    result = await db.execute(text(query), params or {})
    return [dict(r) for r in result.mappings().all()]


async def execute(db: AsyncSession, query: str, params: dict[str, Any] | None = None) -> None:
    await db.execute(text(query), params or {})
