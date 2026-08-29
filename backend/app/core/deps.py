"""
Reusable FastAPI dependencies: current-user extraction from JWT, and
role guards. Every protected route composes these — this is the single
place authorization decisions are enforced server-side (never trust the
frontend to hide a button and call that "secure").
"""
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.security import decode_token

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    id: str
    role: str  # admin | lecturer | student


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> CurrentUser:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_token(creds.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid session")
    return CurrentUser(id=payload["sub"], role=payload["role"])


def require_role(*allowed_roles: str):
    async def _dep(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.role not in allowed_roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not authorized for this resource")
        return user
    return _dep


require_admin = require_role("admin")
require_lecturer = require_role("lecturer")
require_student = require_role("student")
require_admin_or_lecturer = require_role("admin", "lecturer")
