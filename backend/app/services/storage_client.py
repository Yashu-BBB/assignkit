"""
Thin wrapper around the Supabase Storage API. Files are uploaded here;
only the storage path is stored in Postgres (source_documents.storage_path).
"""
import uuid

from supabase import Client, create_client

from app.core.config import get_settings

settings = get_settings()
_client: Client | None = None


def get_supabase() -> Client:
    global _client
    if _client is None:
        _client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
    return _client


def upload_pdf(subject_id: str, filename: str, content: bytes) -> str:
    """Uploads raw PDF bytes to Supabase Storage, returns the storage path."""
    client = get_supabase()
    safe_name = filename.replace(" ", "_")
    path = f"{subject_id}/{uuid.uuid4().hex}_{safe_name}"
    client.storage.from_(settings.SUPABASE_STORAGE_BUCKET).upload(
        path, content, {"content-type": "application/pdf"}
    )
    return path


def get_signed_url(path: str, expires_in: int = 3600) -> str:
    client = get_supabase()
    res = client.storage.from_(settings.SUPABASE_STORAGE_BUCKET).create_signed_url(path, expires_in)
    return res.get("signedURL") or res.get("signed_url", "")


def download_pdf(path: str) -> bytes:
    client = get_supabase()
    return client.storage.from_(settings.SUPABASE_STORAGE_BUCKET).download(path)
