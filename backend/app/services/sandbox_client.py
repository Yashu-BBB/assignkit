"""
Secure code execution. The FastAPI process NEVER executes student code
directly (spec: "isolated sandbox/containers; NEVER execute student code
directly in FastAPI process/server"). This module only talks HTTP to an
external isolated execution service.

V1 assumption (documented per spec section 0 — "if unspecified, choose the
simplest secure option and document the assumption"): we call an external
sandbox API compatible with Judge0/Piston-style "submit code + stdin, get
stdout" semantics. Point SANDBOX_API_URL/SANDBOX_API_KEY at your chosen
provider (self-hosted Judge0, Piston, or a managed equivalent). Swap the
implementation below without touching any caller.
"""
import logging

import httpx

from app.core.config import get_settings
from app.core.errors import SandboxError

logger = logging.getLogger("app.sandbox")
settings = get_settings()

_LANGUAGE_IDS = {  # example mapping for a Judge0-style API — adjust to your provider
    "python": "python3",
    "java": "java",
    "javascript": "node",
}


async def run_code(*, code: str, language: str, stdin: str = "", timeout_seconds: int = 8) -> dict:
    """
    Submits code to the external sandbox and returns:
      {"stdout": str, "stderr": str, "exit_code": int, "timed_out": bool}
    Raises SandboxError if the sandbox itself is unreachable/misconfigured.
    """
    if not settings.SANDBOX_API_URL:
        raise SandboxError("Code execution sandbox is not configured on the server.")

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds + 5) as client:
            resp = await client.post(
                f"{settings.SANDBOX_API_URL}/execute",
                headers={"Authorization": f"Bearer {settings.SANDBOX_API_KEY}"},
                json={
                    "language": _LANGUAGE_IDS.get(language, language),
                    "source_code": code,
                    "stdin": stdin,
                    "timeout_seconds": timeout_seconds,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return {
                "stdout": data.get("stdout", ""),
                "stderr": data.get("stderr", ""),
                "exit_code": data.get("exit_code", -1),
                "timed_out": data.get("timed_out", False),
            }
    except httpx.HTTPError as e:
        logger.error("sandbox_call_failed", extra={"error": str(e)})
        raise SandboxError("Code execution failed. Please try again.")


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
