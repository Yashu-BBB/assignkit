"""
Central configuration. All secrets/config come from environment variables
(Railway env vars in production, .env locally). Nothing here is hardcoded.
"""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- App ---
    APP_NAME: str = "AI Class Assignment Platform"
    ENV: str = "development"  # development | production
    DEBUG: bool = False
    ALLOWED_ORIGINS: str = "*"  # comma-separated in production

    # --- Auth ---
    JWT_SECRET: str  # required — set in Railway env vars
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 8  # 8 hours
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # --- Supabase ---
    SUPABASE_URL: str
    SUPABASE_SERVICE_ROLE_KEY: str  # server-side only, never exposed to frontend
    SUPABASE_STORAGE_BUCKET: str = "assignment-pdfs"

    # --- Database (direct Postgres connection, used by SQLAlchemy) ---
    DATABASE_URL: str  # postgresql+asyncpg://... from Supabase connection string

    # --- AI provider ---
    GEMINI_API_KEY: str = ""  # server env var only, never sent to frontend/admin UI
    GEMINI_MODEL: str = "gemini-flash"
    AI_MAX_RETRIES: int = 3

    # --- Code execution sandbox ---
    # V1: point this at an external sandbox service (e.g. Judge0, Piston,
    # or a self-hosted gVisor/Firecracker runner). The FastAPI process
    # NEVER executes student code directly — see services/sandbox_client.py.
    SANDBOX_API_URL: str = ""
    SANDBOX_API_KEY: str = ""
    CODING_MAX_CHECKS: int = 3

    # --- Cache (Redis) ---
    REDIS_URL: str = ""  # if empty, falls back to in-process TTL cache (see core/cache.py)
    CACHE_DEFAULT_TTL_SECONDS: int = 300

    # --- Uploads ---
    MAX_PDF_SIZE_MB: int = 25
    MIN_OCR_QUALITY_SCORE: float = 0.55

    # --- Feature switches ---
    # Both are off for now. Flip to true in Railway variables (no code change,
    # no frontend redeploy) when the features are ready to go live again.
    FEATURE_PDF_UPLOAD: bool = False        # lecturer class-material PDF upload
    FEATURE_MANUAL_CODING: bool = False     # lecturers writing coding questions by hand

    # --- Rate limiting ---
    RATE_LIMIT_LOGIN_PER_MINUTE: int = 10


@lru_cache
def get_settings() -> Settings:
    return Settings()