import logging

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import cache_delete, cache_get, cache_set
from app.core.config import get_settings
from app.core.database import get_db
from app.core.deps import require_admin
from app.core.errors import TooManyRequestsError, UnauthorizedError
from app.core.security import create_access_token, hash_password, verify_password
from app.schemas.auth import LoginRequest, PasswordResetRequest, TokenResponse
from app.utils.db_helpers import execute, fetch_one

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("app.auth")
settings = get_settings()

_TABLE_BY_ROLE = {"admin": "admins", "lecturer": "lecturers", "student": "students"}
_IDENTIFIER_COL = {"admin": "username", "lecturer": "lecturer_id", "student": "register_number"}

_LOGIN_ATTEMPT_WINDOW_SECONDS = 60


async def _rate_limit_key(role: str, identifier: str, client_ip: str) -> str:
    # Keyed by identifier+IP together: blocks a targeted attack on one
    # account without letting one bad actor lock out everyone sharing an IP
    # (e.g. a whole campus NAT), and vice versa.
    return f"login_attempts:{role}:{identifier}:{client_ip}"


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    role = payload.role
    if role not in _TABLE_BY_ROLE:
        raise UnauthorizedError("Invalid role selected.")

    client_ip = request.client.host if request.client else "unknown"
    rate_key = await _rate_limit_key(role, payload.identifier, client_ip)
    attempts = await cache_get(rate_key) or 0
    if attempts >= settings.RATE_LIMIT_LOGIN_PER_MINUTE:
        logger.warning("login_rate_limited", extra={"role": role, "identifier": payload.identifier,
                                                       "ip": client_ip})
        raise TooManyRequestsError(
            "Too many login attempts. Please wait a minute and try again.", code="rate_limited",
        )

    table = _TABLE_BY_ROLE[role]
    id_col = _IDENTIFIER_COL[role]
    user = await fetch_one(
        db, f"select * from {table} where {id_col} = :ident", {"ident": payload.identifier}
    )

    if not user or not verify_password(payload.password, user["password_hash"]):
        await cache_set(rate_key, attempts + 1, ttl=_LOGIN_ATTEMPT_WINDOW_SECONDS)
        logger.warning("login_failed", extra={"role": role, "identifier": payload.identifier})
        raise UnauthorizedError("Invalid credentials.", code="invalid_login")

    if role != "admin" and not user.get("is_active", True):
        raise UnauthorizedError("This account has been deactivated.", code="account_inactive")

    # Successful login clears any accumulated failed-attempt count for this
    # identifier+IP, so a legitimate user who mistyped a few times isn't
    # left partway toward a lockout next time.
    await cache_delete(rate_key)

    token = create_access_token(subject=str(user["id"]), role=role)
    logger.info("login_success", extra={"role": role, "user_id": user["id"]})
    return TokenResponse(
        access_token=token, role=role, id=str(user["id"]), full_name=user.get("full_name", "Admin")
    )


@router.post("/reset-password", status_code=204)
async def reset_password(
    payload: PasswordResetRequest,
    db: AsyncSession = Depends(get_db),
    _admin=Depends(require_admin),
):
    """Admin resets any lecturer's or student's password. Replaces immediately. No email/OTP in V1."""
    table = _TABLE_BY_ROLE.get(payload.role)
    if table not in ("lecturers", "students"):
        raise UnauthorizedError("Can only reset lecturer or student passwords.", code="invalid_role")

    await execute(
        db,
        f"update {table} set password_hash = :ph, updated_at = now() where id = :id",
        {"ph": hash_password(payload.new_password), "id": payload.user_id},
    )
    await db.commit()
    logger.info("password_reset", extra={"target_role": payload.role, "target_id": payload.user_id})