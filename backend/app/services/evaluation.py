"""
Local evaluation for MCQ and short-answer questions — never calls AI per
student answer (spec: "Normal MCQ/Short Answer evaluation does not call AI").
Coding evaluation goes through services/sandbox_client.py instead.
"""
import re


def evaluate_mcq(selected_option_id: str, correct_option_id: str) -> tuple[bool, float]:
    is_correct = selected_option_id == correct_option_id
    return is_correct, (1.0 if is_correct else 0.0)


def evaluate_short_answer(student_answer: str, accepted_answers: list[dict]) -> tuple[bool, float]:
    """
    accepted_answers: rows from `accepted_answers` table, each with
    answer_text and match_type (exact_ci | contains | regex).
    """
    normalized = student_answer.strip().lower()

    for accepted in accepted_answers:
        answer_text = accepted["answer_text"]
        match_type = accepted.get("match_type", "exact_ci")

        if match_type == "exact_ci" and normalized == answer_text.strip().lower():
            return True, 1.0
        if match_type == "contains" and answer_text.strip().lower() in normalized:
            return True, 1.0
        if match_type == "regex":
            try:
                if re.fullmatch(answer_text, student_answer.strip(), flags=re.IGNORECASE):
                    return True, 1.0
            except re.error:
                continue

    return False, 0.0
