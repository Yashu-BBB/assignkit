import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging_config import get_logger, request_id_ctx, setup_logging
from app.routers import admin, analytics, archive, assignments, auth, lecturer, student

settings = get_settings()
setup_logging(settings.ENV)
logger = get_logger("app.main")

app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    docs_url="/api/docs" if settings.ENV != "production" else None,
    redoc_url=None,
)

origins = ["*"] if settings.ALLOWED_ORIGINS == "*" else settings.ALLOWED_ORIGINS.split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_exception_handlers(app)


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):
    """Assigns a correlation ID to every request for structured logs, and times it."""
    req_id = uuid.uuid4().hex[:12]
    token = request_id_ctx.set(req_id)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        request_id_ctx.reset(token)
    duration_ms = round((time.perf_counter() - start) * 1000, 1)
    response.headers["X-Request-ID"] = req_id
    if request.url.path.startswith("/api/"):
        # Defensive: /api/* responses are token-gated per-user data and must
        # never be cached by a CDN/proxy (e.g. Railway's edge) or the browser.
        response.headers["Cache-Control"] = "no-store"
    logger.info("request_completed", extra={
        "request_id": req_id, "method": request.method, "path": request.url.path,
        "status_code": response.status_code, "duration_ms": duration_ms,
    })
    return response


app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(lecturer.router)
app.include_router(student.router)
app.include_router(assignments.router)
app.include_router(analytics.router)
app.include_router(archive.router)


@app.get("/api/features")
async def features():
    """Public, read-only. Lets the UI show 'temporarily unavailable' without
    hardcoding it. The backend still enforces every flag on its own."""
    return {
        "pdf_upload": settings.FEATURE_PDF_UPLOAD,
        "manual_coding": settings.FEATURE_MANUAL_CODING,
    }


@app.get("/api/health")
async def health():
    return {"status": "ok", "env": settings.ENV}


# ---------------------------------------------------------------------------
# Static frontend (plain HTML/CSS/JS, no build step). Mounted last so it
# never shadows the /api/* routes above. FRONTEND_DIR defaults to the path
# baked in by the Dockerfile; override for local dev if running the two
# separately (see README "Run frontend and backend separately").
# ---------------------------------------------------------------------------
frontend_dir = os.getenv("FRONTEND_DIR", "/app/frontend")
if os.path.isdir(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")