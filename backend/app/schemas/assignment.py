from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ManualMCQInput(BaseModel):
    prompt: str
    options: list[str] = Field(..., min_length=2, max_length=8)
    correct_option_index: int
    difficulty: Literal["easy", "medium", "hard"] | None = None


class ManualShortAnswerInput(BaseModel):
    prompt: str
    accepted_answers: list[str] = Field(..., min_length=1)
    difficulty: Literal["easy", "medium", "hard"] | None = None


class ManualCodingInput(BaseModel):
    prompt: str
    language: Literal["python", "java", "javascript"] | None = None
    expected_behavior: str
    sample_input: str | None = None
    sample_output: str | None = None
    constraints: str | None = None
    hidden_test_cases: list[dict] = Field(default_factory=list)  # [{input, expected_output}]
    difficulty: Literal["easy", "medium", "hard"] | None = None


class AssignmentCreate(BaseModel):
    subject_id: str
    title: str
    mode: Literal["manual", "ai", "hybrid"]

    total_questions: int
    mcq_count: int = 0
    short_answer_count: int = 0
    coding_count: int = 0

    num_sets: int = 1
    overall_difficulty: Literal["easy", "medium", "hard"] = "medium"

    timer_seconds_default: int = 45
    start_at: datetime
    deadline_at: datetime
    result_buffer_seconds: int = 0

    general_ai_instructions: str | None = None
    mcq_ai_instructions: str | None = None
    short_answer_ai_instructions: str | None = None
    coding_ai_instructions: str | None = None

    manual_mcqs: list[ManualMCQInput] = Field(default_factory=list)
    manual_short_answers: list[ManualShortAnswerInput] = Field(default_factory=list)
    manual_coding: list[ManualCodingInput] = Field(default_factory=list)

    source_document_id: str | None = None  # set after PDF upload/processing

    @model_validator(mode="after")
    def counts_must_match(self):
        if self.mcq_count + self.short_answer_count + self.coding_count != self.total_questions:
            raise ValueError("mcq_count + short_answer_count + coding_count must equal total_questions")
        if self.deadline_at <= self.start_at:
            raise ValueError("deadline_at must be after start_at")
        if self.mode == "manual":
            if (len(self.manual_mcqs) < self.mcq_count
                    or len(self.manual_short_answers) < self.short_answer_count
                    or len(self.manual_coding) < self.coding_count):
                raise ValueError("Manual mode requires all questions to be supplied manually")
        for i, code_q in enumerate(self.manual_coding, start=1):
            has_sample = bool(code_q.sample_input) and bool(code_q.sample_output)
            if not code_q.hidden_test_cases and not has_sample:
                raise ValueError(
                    f"Coding question {i} has no sample or hidden test cases — it cannot be "
                    f"auto-graded. Add at least one test case (sample_input/sample_output or "
                    f"a hidden_test_cases entry)."
                )
        return self


class AssignmentOut(BaseModel):
    id: str
    subject_id: str
    title: str
    mode: str
    status: str
    total_questions: int
    mcq_count: int
    short_answer_count: int
    coding_count: int
    num_sets: int
    overall_difficulty: str
    start_at: datetime
    deadline_at: datetime
    created_at: datetime


class AnswerSubmit(BaseModel):
    student_question_id: str
    answer_text: str


class CodingCheckRequest(BaseModel):
    student_question_id: str
    code: str
    language: Literal["python", "java", "javascript"]
    is_final: bool = False