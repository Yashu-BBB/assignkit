"""
Gemini Flash integration. Kept behind a small interface (extract_knowledge /
generate_questions / validate_question) so the AI provider can be swapped
later without touching callers (spec section 32: "keep modules replaceable").

Design choices per spec:
 - Structured JSON/schema outputs only.
 - Bounded retries on failure.
 - Never send the full PDF per call — callers pass the compact knowledge
   representation, not raw PDF text, once extraction is done.
 - AI must not introduce outside concepts / must stay close to source wording.
"""
import json
import logging

import google.generativeai as genai

from app.core.config import get_settings
from app.core.errors import AIUnavailableError

logger = logging.getLogger("app.ai")
settings = get_settings()

if settings.GEMINI_API_KEY:
    genai.configure(api_key=settings.GEMINI_API_KEY)

_model = None


def _get_model():
    global _model
    if _model is None:
        if not settings.GEMINI_API_KEY:
            raise AIUnavailableError(
                "AI generation is not configured on the server (missing GEMINI_API_KEY).",
            )
        _model = genai.GenerativeModel(settings.GEMINI_MODEL)
    return _model


async def _call_json(prompt: str, *, max_retries: int | None = None) -> dict | list:
    """Calls Gemini expecting a strict JSON response. Retries on failure/parse errors."""
    model = _get_model()
    attempts = max_retries or settings.AI_MAX_RETRIES
    last_error: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            response = model.generate_content(
                prompt,
                generation_config={"response_mime_type": "application/json"},
            )
            return json.loads(response.text)
        except Exception as e:  # noqa: BLE001 — bounded retry wraps any provider/parse failure
            last_error = e
            logger.warning("ai_call_retry", extra={"attempt": attempt, "error": str(e)})

    logger.error("ai_call_failed", extra={"error": str(last_error)})
    raise AIUnavailableError("AI generation failed after retries. The assignment has been saved as a draft.")


async def extract_knowledge(raw_text: str) -> list[dict]:
    """
    Turns raw extracted PDF text into a compact structured knowledge map:
    topics, concepts, definitions, examples, key terms, code patterns.
    This is stored once and reused for all future generation calls.
    """
    # Truncate defensively — extraction is a one-time cost per document,
    # but we still cap input size to control token usage on very large PDFs.
    text_sample = raw_text[:60000]
    prompt = f"""You are extracting a compact knowledge map from class material for later use
in generating exam questions. Read the material and return ONLY a JSON array of objects,
each with: topic, concept, definition, examples (array of short strings),
key_terms (array of strings), code_patterns (array of short strings, empty if not applicable),
raw_excerpt (a short grounding excerpt, under 300 characters).
Stay strictly faithful to the material — do not add outside knowledge.

MATERIAL:
{text_sample}
"""
    result = await _call_json(prompt)
    return result if isinstance(result, list) else result.get("items", [])


async def generate_question_sets(
    *, knowledge_items: list[dict], mcq_count: int, short_answer_count: int, coding_count: int,
    num_sets: int, difficulty: str, general_instructions: str | None,
    mcq_instructions: str | None, short_answer_instructions: str | None, coding_instructions: str | None,
) -> list[list[dict]]:
    """
    Generates `num_sets` independent sets, each with identical type counts,
    same concepts/objectives/difficulty, but varied wording/values/scenarios.
    Returns a list (per set) of lists of question dicts. Caller runs these
    through validate_question before publishing (spec section 9).
    """
    knowledge_summary = json.dumps(knowledge_items[:80], ensure_ascii=False)  # compact, not raw PDF

    prompt = f"""Generate {num_sets} equivalent question sets for a class assessment, grounded ONLY
in the knowledge map below. Do not introduce outside concepts. Keep terminology close to the
source material.

Each set must contain exactly:
- {mcq_count} multiple-choice questions
- {short_answer_count} short-answer questions
- {coding_count} coding questions

All sets must share the same question types, learning objectives, concept coverage, and
difficulty ("{difficulty}"), but differ in wording, values, scenarios, examples, or code.

General instructions: {general_instructions or "none"}
MCQ instructions: {mcq_instructions or "none"}
Short-answer instructions: {short_answer_instructions or "none"}
Coding instructions: {coding_instructions or "none"}

KNOWLEDGE MAP:
{knowledge_summary}

Return ONLY a JSON object: {{"sets": [[question, ...], ...]}} with {num_sets} inner arrays.
Each MCQ question object: {{"type":"mcq","prompt":str,"options":[str,...],"correct_option_index":int,
  "topic":str,"concept":str,"learning_objective":str,"key_terms":[str,...]}}
Each short-answer object: {{"type":"short_answer","prompt":str,"accepted_answers":[str,...],
  "topic":str,"concept":str,"learning_objective":str,"key_terms":[str,...]}}
Each coding object: {{"type":"coding","prompt":str,"language":"python"|"java"|"javascript",
  "expected_behavior":str,"constraints":str,
  "test_cases":[{{"input":str,"expected_output":str,"is_sample":bool}}, ...],
  "topic":str,"concept":str,"learning_objective":str,"key_terms":[str,...]}}
"""
    result = await _call_json(prompt)
    sets = result.get("sets", []) if isinstance(result, dict) else result
    for q_set in sets:
        for q in q_set:
            q["difficulty"] = difficulty
    return sets


async def validate_question(question: dict, knowledge_items: list[dict]) -> dict:
    """
    Validates a single AI-generated question against the knowledge map:
    groundedness, correct answer/key, correct type, difficulty, no ambiguity,
    appropriate terminology, valid objective, and (for coding) logical evaluability.
    Returns {"valid": bool, "notes": str, "corrected": dict | None}.
    """
    knowledge_summary = json.dumps(knowledge_items[:40], ensure_ascii=False)
    prompt = f"""Validate this generated question against the knowledge map. Check: it is grounded
in the material, the answer/key is correct, the question type matches its content, difficulty is
appropriate, there is no ambiguity, terminology matches the source material, and (if coding) the
problem is logically valid and evaluable via test cases.

QUESTION: {json.dumps(question, ensure_ascii=False)}
KNOWLEDGE MAP: {knowledge_summary}

Return ONLY JSON: {{"valid": bool, "notes": str}}
"""
    return await _call_json(prompt)
