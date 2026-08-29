"""
Caching layer. Uses Redis when REDIS_URL is configured; otherwise falls
back to a simple in-process TTL cache so V1 still runs without Redis
provisioned (per spec: "Redis if appropriate; otherwise a simple robust
cache"). Swappable behind the same interface so callers never care which
backend is active.

Cache safe/read-heavy data only: profiles, subject lists, assignment
metadata, question-bank metadata, config. NEVER cache per-student answers
or anything sensitive in a shared/unscoped key.
"""
import json
import time
from typing import Any

from app.core.config import get_settings

settings = get_settings()


class _InProcessCache:
    def __init__(self):
        self._store: dict[str, tuple[float, Any]] = {}

    async def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if not entry:
            return None
        expires_at, value = entry
        if expires_at < time.time():
            self._store.pop(key, None)
            return None
        return value

    async def set(self, key: str, value: Any, ttl: int) -> None:
        self._store[key] = (time.time() + ttl, value)

    async def delete(self, key: str) -> None:
        self._store.pop(key, None)

    async def delete_prefix(self, prefix: str) -> None:
        for k in [k for k in self._store if k.startswith(prefix)]:
            self._store.pop(k, None)


class _RedisCache:
    def __init__(self, url: str):
        import redis.asyncio as redis  # imported lazily so Redis is optional
        self._client = redis.from_url(url, decode_responses=True)

    async def get(self, key: str) -> Any | None:
        raw = await self._client.get(key)
        return json.loads(raw) if raw else None

    async def set(self, key: str, value: Any, ttl: int) -> None:
        await self._client.set(key, json.dumps(value, default=str), ex=ttl)

    async def delete(self, key: str) -> None:
        await self._client.delete(key)

    async def delete_prefix(self, prefix: str) -> None:
        async for k in self._client.scan_iter(f"{prefix}*"):
            await self._client.delete(k)


_cache = _RedisCache(settings.REDIS_URL) if settings.REDIS_URL else _InProcessCache()


async def cache_get(key: str) -> Any | None:
    return await _cache.get(key)


async def cache_set(key: str, value: Any, ttl: int | None = None) -> None:
    await _cache.set(key, value, ttl or settings.CACHE_DEFAULT_TTL_SECONDS)


async def cache_delete(key: str) -> None:
    await _cache.delete(key)


async def cache_invalidate_prefix(prefix: str) -> None:
    """Call this whenever underlying data for `prefix` changes."""
    await _cache.delete_prefix(prefix)
