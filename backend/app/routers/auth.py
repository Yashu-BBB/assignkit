import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import require_admin
from app.core.errors import UnauthorizedError
from app.core.security import create_access_token, hash_password, verify_password
from app.schemas.auth import LoginRequest, PasswordResetRequest, TokenResponse
from app.utils.db_helpers import execute, fetch_one

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("app.auth")

_TABLE_BY_ROLE = {"admin": "admins", "lecturer": "lecturers", "student": "students"}
_IDENTIFIER_COL = {"admin": "username", "lecturer": "lecturer_id", "student": "register_number"}


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    role = payload.role
    if role not in _TABLE_BY_ROLE:
        raise UnauthorizedError("Invalid role selected.")

    table = _TABLE_BY_ROLE[role]
    id_col = _IDENTIFIER_COL[role]
    user = await fetch_one(
        db, f"select * from {table} where {id_col} = :ident", {"ident": payload.identifier}
    )

    if not user or not verify_password(payload.password, user["password_hash"]):
        logger.warning("login_failed", extra={"role": role, "identifier": payload.identifier})
        raise UnauthorizedError("Invalid credentials.", code="invalid_login")

    if role != "admin" and not user.get("is_active", True):
        raise UnauthorizedError("This account has been deactivated.", code="account_inactive")

    token = create_access_token(subject=user["id"], role=role)
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
