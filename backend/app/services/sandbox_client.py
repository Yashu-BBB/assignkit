"""
Secure code execution. The FastAPI process NEVER executes student code
directly (spec: "isolated sandbox/containers; NEVER execute student code
directly in FastAPI process/server"). This module only talks HTTP to an
external isolated execution service.

Implemented against Piston (https://github.com/engineer-man/piston) — free,
open-source, no API key required. Default SANDBOX_API_URL points at the
public hosted instance (emkc.org), which is fine for development/small
classes. For production/heavier load, self-host Piston (single Docker
container, no database) and point SANDBOX_API_URL at your own instance —
no other code changes needed. See README §5.
"""
import logging

import httpx

from app.core.config import get_settings
from app.core.errors import SandboxError

logger = logging.getLogger("app.sandbox")
settings = get_settings()

# Piston "language" + "version" — confirm current versions available on your
# instance via GET {SANDBOX_API_URL}/runtimes if these ever drift.
_LANGUAGE_CONFIG = {
    "python": {"language": "python", "version": "3.10.0", "filename": "main.py"},
    "java": {"language": "java", "version": "15.0.2", "filename": "Main.java"},
    "javascript": {"language": "javascript", "version": "18.15.0", "filename": "main.js"},
}


def _base_url() -> str:
    return settings.SANDBOX_API_URL or "https://emkc.org/api/v2/piston"


async def run_code(*, code: str, language: str, stdin: str = "", timeout_seconds: int = 8) -> dict:
    """
    Submits code to Piston and returns:
      {"stdout": str, "stderr": str, "exit_code": int, "timed_out": bool}
    Raises SandboxError if the sandbox itself is unreachable/misconfigured.
    """
    config = _LANGUAGE_CONFIG.get(language)
    if config is None:
        raise SandboxError(f"Unsupported language: {language}")

    payload = {
        "language": config["language"],
        "version": config["version"],
        "files": [{"name": config["filename"], "content": code}],
        "stdin": stdin,
        "run_timeout": timeout_seconds * 1000,  # Piston expects milliseconds
    }
    headers = {"Content-Type": "application/json"}
    if settings.SANDBOX_API_KEY:  # only needed if you add auth in front of a self-hosted instance
        headers["Authorization"] = f"Bearer {settings.SANDBOX_API_KEY}"

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds + 10) as client:
            resp = await client.post(f"{_base_url()}/execute", headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        logger.error("sandbox_call_failed", extra={"error": str(e)})
        raise SandboxError("Code execution failed. Please try again.")

    run = data.get("run", {})
    compile_step = data.get("compile", {})
    timed_out = run.get("signal") == "SIGKILL"  # Piston's timeout signal

    stderr = run.get("stderr", "")
    if compile_step.get("stderr"):
        stderr = compile_step["stderr"] + "\n" + stderr  # surface compile errors (Java) too

    return {
        "stdout": run.get("stdout", ""),
        "stderr": stderr,
        "exit_code": run.get("code", -1) if run.get("code") is not None else -1,
        "timed_out": timed_out,
    }


async def evaluate_against_test_cases(*, code: str, language: str, test_cases: list[dict]) -> dict:
    """
    Runs code against each test case's input and compares stdout to
    expected_output (trimmed). Returns pass/fail counts and per-case detail —
    used for both "Check" (sample cases) and final "Submit" (all cases).
    """
    results = []
    passed = 0
    for tc in test_cases:
        run = await run_code(code=code, language=language, stdin=tc.get("input") or "")
        ok = run["stdout"].strip() == (tc.get("expected_output") or "").strip() and not run["timed_out"]
        passed += int(ok)
        results.append({
            "passed": ok, "is_sample": tc.get("is_sample", False),
            "stdout": run["stdout"] if tc.get("is_sample") else None,  # don't leak hidden case output
            "stderr": run["stderr"][:500],
        })
    return {"passed": passed, "total": len(test_cases), "results": results}