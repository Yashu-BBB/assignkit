"""
Centralized error handling. Students/lecturers/admins never see raw stack
traces — only understandable, actionable messages with a stable error
`code` the frontend can branch on (invalid login, deadline passed, etc).
Full details go to structured logs only.
"""
import logging
import traceback

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger("app.errors")


class AppError(Exception):
    """Base class for all expected/handled application errors."""
    status_code = status.HTTP_400_BAD_REQUEST
    code = "app_error"

    def __init__(self, message: str, *, code: str | None = None, status_code: int | None = None):
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        super().__init__(message)


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"


class UnauthorizedError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"


class ForbiddenError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"


class TooManyRequestsError(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "too_many_requests"


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"


class DeadlinePassedError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "deadline_passed"


class AssignmentUnavailableError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "assignment_unavailable"


class PDFUnreadableError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "pdf_unreadable"


class AIUnavailableError(AppError):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = "ai_unavailable"


class SandboxError(AppError):
    status_code = status.HTTP_502_BAD_GATEWAY
    code = "code_execution_failed"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError):
        logger.warning("app_error", extra={"code": exc.code, "path": str(request.url)})
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"error": {"code": "validation_error", "message": "Invalid request data.",
                                "fields": exc.errors()}},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception):
        logger.error(
            "unhandled_exception",
            extra={"path": str(request.url), "trace": traceback.format_exc()},
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": {"code": "internal_error",
                                "message": "Something went wrong. Please try again."}},
        )