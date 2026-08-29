from pydantic import BaseModel


class LoginRequest(BaseModel):
    identifier: str  # admin username | lecturer_id | student register_number
    password: str
    role: str  # "admin" | "lecturer" | "student" — selected on the login screen


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    id: str
    full_name: str


class PasswordResetRequest(BaseModel):
    user_id: str
    role: str  # "lecturer" | "student"
    new_password: str
