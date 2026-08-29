"""
Async SQLAlchemy engine/session. We use SQLAlchemy Core/ORM against the
Supabase Postgres connection string (DATABASE_URL) for all application
queries — parameterized by default, so this is our SQL-injection defense.
Supabase Storage is accessed separately via the Supabase client (see
services/storage_client.py) for file upload/download only.
"""
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import get_settings

settings = get_settings()

engine = create_async_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=10,
    echo=settings.DEBUG,
    # Supabase's pooled connection (the "Transaction pooler", port 6543) does
    # not support asyncpg's server-side prepared statement caching — it
    # causes "DuplicatePreparedStatementError" under any concurrent load.
    # Disabling the cache is the standard fix when using PgBouncer in
    # transaction/statement pooling mode.
    connect_args={"statement_cache_size": 0},
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine, autoflush=False, expire_on_commit=False, class_=AsyncSession
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a request-scoped DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()