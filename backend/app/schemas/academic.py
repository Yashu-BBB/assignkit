from datetime import datetime

from pydantic import BaseModel, Field


class SemesterCreate(BaseModel):
    name: str


class SemesterOut(BaseModel):
    id: str
    name: str
    is_active: bool


class SectionCreate(BaseModel):
    semester_id: str
    name: str


class SectionOut(BaseModel):
    id: str
    semester_id: str
    name: str


class LecturerCreate(BaseModel):
    lecturer_id: str
    full_name: str
    password: str
    email: str | None = None


class LecturerOut(BaseModel):
    id: str
    lecturer_id: str
    full_name: str
    email: str | None = None
    is_active: bool


class StudentCreate(BaseModel):
    register_number: str
    full_name: str
    password: str
    semester_id: str
    section_id: str


class StudentBulkRow(BaseModel):
    register_number: str
    full_name: str
    password: str
    semester_id: str
    section_id: str


class StudentBulkCreate(BaseModel):
    students: list[StudentBulkRow] = Field(..., min_length=1)


class StudentOut(BaseModel):
    id: str
    register_number: str
    full_name: str
    semester_id: str | None
    section_id: str | None
    is_active: bool


class SubjectCreate(BaseModel):
    section_id: str
    name: str
    description: str | None = None


class SubjectOut(BaseModel):
    id: str
    section_id: str
    lecturer_id: str
    name: str
    description: str | None
    is_active: bool
