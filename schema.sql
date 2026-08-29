-- =====================================================================
-- AI CLASS ASSIGNMENT PLATFORM — V1 SCHEMA
-- Target: Supabase PostgreSQL
-- Run this once against a fresh Supabase project (SQL Editor or psql).
-- Idempotent-ish: uses IF NOT EXISTS / CREATE OR REPLACE where sensible.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. EXTENSIONS
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";    -- fuzzy text search for question bank / dup detection

-- ---------------------------------------------------------------------
-- 1. ENUM TYPES
-- ---------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('admin', 'lecturer', 'student');
exception when duplicate_object then null; end $$;

do $$ begin
  create type assignment_mode as enum ('manual', 'ai', 'hybrid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type difficulty_level as enum ('easy', 'medium', 'hard');
exception when duplicate_object then null; end $$;

do $$ begin
  create type question_type as enum ('mcq', 'short_answer', 'coding');
exception when duplicate_object then null; end $$;

do $$ begin
  create type question_source as enum ('manual', 'ai', 'bank');
exception when duplicate_object then null; end $$;

do $$ begin
  create type question_status as enum ('pending_validation', 'valid', 'invalid', 'unusable', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type assignment_status as enum ('draft', 'generating', 'scheduled', 'active', 'closed', 'archived', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type attempt_status as enum ('not_started', 'in_progress', 'submitted', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pdf_status as enum ('uploaded', 'processing', 'ready', 'low_quality', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type violation_type as enum ('tab_switch', 'copy_paste', 'window_blur', 'devtools', 'multiple_faces', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type coding_language as enum ('python', 'java', 'javascript');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 2. IDENTITY / USERS
-- ---------------------------------------------------------------------
create table if not exists admins (
  id              uuid primary key default gen_random_uuid(),
  username        text not null unique,
  password_hash   text not null,
  full_name       text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists lecturers (
  id              uuid primary key default gen_random_uuid(),
  lecturer_id     text not null unique,       -- login identifier, admin-assigned
  password_hash   text not null,
  full_name       text not null,
  email           text,
  is_active       boolean not null default true,
  created_by      uuid references admins(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists semesters (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,              -- e.g. "Semester 5, 2026"
  is_active       boolean not null default true,
  created_by      uuid references admins(id),
  created_at      timestamptz not null default now(),
  unique (name)
);

create table if not exists sections (
  id              uuid primary key default gen_random_uuid(),
  semester_id     uuid not null references semesters(id) on delete cascade,
  name            text not null,              -- e.g. "A", "B"
  created_by      uuid references admins(id),
  created_at      timestamptz not null default now(),
  unique (semester_id, name)
);

create table if not exists students (
  id                  uuid primary key default gen_random_uuid(),
  register_number     text not null unique,   -- login identifier
  password_hash       text not null,
  full_name           text not null,
  current_semester_id uuid references semesters(id),
  current_section_id  uuid references sections(id),
  is_active           boolean not null default true,
  created_by          uuid references admins(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_students_sem_sec on students(current_semester_id, current_section_id);

-- Optional: keep a history of semester/section changes for auditability
create table if not exists student_enrollment_history (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references students(id) on delete cascade,
  semester_id     uuid references semesters(id),
  section_id      uuid references sections(id),
  effective_from  timestamptz not null default now(),
  effective_to    timestamptz
);

-- ---------------------------------------------------------------------
-- 3. ACADEMIC STRUCTURE — SUBJECTS
-- ---------------------------------------------------------------------
-- A "subject instance" = one subject taught by one lecturer in one section.
-- This is the unit everything (assignments, students, analytics) hangs off.
create table if not exists subjects (
  id              uuid primary key default gen_random_uuid(),
  section_id      uuid not null references sections(id) on delete cascade,
  lecturer_id     uuid not null references lecturers(id) on delete cascade,
  name            text not null,
  description     text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_subjects_lecturer on subjects(lecturer_id);
create index if not exists idx_subjects_section on subjects(section_id);

-- Derived view: which students belong to a subject (via section match).
-- No duplication — students are matched live by current semester+section.
create or replace view subject_students as
select
  sub.id as subject_id,
  s.id as student_id
from subjects sub
join sections sec on sec.id = sub.section_id
join students s
  on s.current_semester_id = sec.semester_id
 and s.current_section_id = sec.id
where sub.is_active = true and s.is_active = true;

-- ---------------------------------------------------------------------
-- 4. SOURCE DOCUMENTS (PDFs) + KNOWLEDGE REPRESENTATION
-- ---------------------------------------------------------------------
create table if not exists source_documents (
  id                  uuid primary key default gen_random_uuid(),
  subject_id          uuid not null references subjects(id) on delete cascade,
  uploaded_by         uuid not null references lecturers(id),
  storage_path        text not null,          -- Supabase Storage object path
  original_filename   text not null,
  status              pdf_status not null default 'uploaded',
  page_count          integer,
  quality_notes        text,
  created_at          timestamptz not null default now(),
  processed_at        timestamptz
);
create index if not exists idx_source_documents_subject on source_documents(subject_id);

-- Compact structured knowledge extracted from a source document.
-- This is what AI generation reads from — never the raw PDF repeatedly.
create table if not exists extracted_knowledge (
  id                  uuid primary key default gen_random_uuid(),
  source_document_id  uuid not null references source_documents(id) on delete cascade,
  topic               text not null,
  concept             text,
  definition          text,
  examples            jsonb default '[]'::jsonb,
  key_terms           jsonb default '[]'::jsonb,
  code_patterns       jsonb default '[]'::jsonb,
  raw_excerpt         text,                   -- short grounding excerpt, not full page
  embedding_ref       text,                   -- optional pointer if vector search added later
  created_at          timestamptz not null default now()
);
create index if not exists idx_extracted_knowledge_doc on extracted_knowledge(source_document_id);
create index if not exists idx_extracted_knowledge_topic on extracted_knowledge using gin (to_tsvector('english', topic || ' ' || coalesce(concept,'')));

-- ---------------------------------------------------------------------
-- 5. ASSIGNMENTS
-- ---------------------------------------------------------------------
create table if not exists assignments (
  id                      uuid primary key default gen_random_uuid(),
  subject_id              uuid not null references subjects(id) on delete cascade,
  source_document_id      uuid references source_documents(id),
  title                   text not null,
  mode                    assignment_mode not null,
  status                  assignment_status not null default 'draft',

  total_questions         integer not null,
  mcq_count               integer not null default 0,
  short_answer_count      integer not null default 0,
  coding_count            integer not null default 0,

  num_sets                integer not null default 1,
  overall_difficulty      difficulty_level not null default 'medium',

  timer_seconds_default   integer not null default 45,   -- MCQ/Short Answer timer
  start_at                timestamptz not null,
  deadline_at             timestamptz not null,
  result_buffer_seconds   integer not null default 0,     -- leaderboard/result reveal delay after deadline

  general_ai_instructions      text,
  mcq_ai_instructions          text,
  short_answer_ai_instructions text,
  coding_ai_instructions       text,

  created_by              uuid not null references lecturers(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint chk_question_counts check (
    mcq_count + short_answer_count + coding_count = total_questions
  ),
  constraint chk_dates check (deadline_at > start_at)
);
create index if not exists idx_assignments_subject on assignments(subject_id);
create index if not exists idx_assignments_status on assignments(status);

-- ---------------------------------------------------------------------
-- 6. QUESTION BANK (lecturer-scoped, reusable across assignments)
-- ---------------------------------------------------------------------
create table if not exists questions (
  id                  uuid primary key default gen_random_uuid(),
  lecturer_id         uuid not null references lecturers(id) on delete cascade,
  assignment_id       uuid references assignments(id) on delete set null,  -- originating assignment, if any
  source_document_id  uuid references source_documents(id),

  type                question_type not null,
  source              question_source not null,
  status              question_status not null default 'pending_validation',

  prompt              text not null,
  difficulty          difficulty_level not null default 'medium',
  topic               text,
  concept             text,
  learning_objective  text,
  key_terms           jsonb default '[]'::jsonb,

  -- coding-specific
  coding_language     coding_language,
  expected_behavior   text,
  constraints_text    text,

  validation_notes    text,
  is_reusable         boolean not null default true,
  usage_count         integer not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_questions_lecturer on questions(lecturer_id);
create index if not exists idx_questions_lecturer_status on questions(lecturer_id, status, type);
create index if not exists idx_questions_topic_trgm on questions using gin (prompt gin_trgm_ops);

create table if not exists question_options (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null references questions(id) on delete cascade,
  option_text     text not null,
  is_correct      boolean not null default false,
  option_order    integer not null default 0
);
create index if not exists idx_question_options_question on question_options(question_id);

create table if not exists accepted_answers (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null references questions(id) on delete cascade,
  answer_text     text not null,
  match_type      text not null default 'exact_ci'  -- exact_ci | contains | regex (evaluated server-side)
);
create index if not exists idx_accepted_answers_question on accepted_answers(question_id);

create table if not exists coding_test_cases (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null references questions(id) on delete cascade,
  input_data      text,
  expected_output text not null,
  is_sample       boolean not null default false,   -- shown to student vs hidden
  weight          numeric not null default 1
);
create index if not exists idx_coding_test_cases_question on coding_test_cases(question_id);

-- ---------------------------------------------------------------------
-- 7. QUESTION SETS (per assignment)
-- ---------------------------------------------------------------------
create table if not exists question_sets (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid not null references assignments(id) on delete cascade,
  set_index       integer not null,          -- 1..num_sets
  created_at      timestamptz not null default now(),
  unique (assignment_id, set_index)
);

create table if not exists set_questions (
  id              uuid primary key default gen_random_uuid(),
  question_set_id uuid not null references question_sets(id) on delete cascade,
  question_id     uuid not null references questions(id) on delete cascade,
  position        integer not null default 0,   -- base order (per-student order is separate)
  unique (question_set_id, question_id)
);
create index if not exists idx_set_questions_set on set_questions(question_set_id);

-- ---------------------------------------------------------------------
-- 8. STUDENT ASSIGNMENT INSTANCES + ATTEMPTS
-- ---------------------------------------------------------------------
create table if not exists student_assignment_instances (
  id                  uuid primary key default gen_random_uuid(),
  assignment_id       uuid not null references assignments(id) on delete cascade,
  student_id          uuid not null references students(id) on delete cascade,
  question_set_id     uuid not null references question_sets(id),
  question_order      jsonb not null,          -- ordered array of question_ids, shuffled per student
  status              attempt_status not null default 'not_started',
  started_at          timestamptz,
  submitted_at        timestamptz,
  expires_at          timestamptz,             -- server-enforced deadline/lock time for this student
  total_score         numeric,
  max_score           numeric,
  created_at          timestamptz not null default now(),
  unique (assignment_id, student_id)           -- one attempt per student
);
create index if not exists idx_sai_assignment on student_assignment_instances(assignment_id);
create index if not exists idx_sai_student on student_assignment_instances(student_id);

create table if not exists student_question_instances (
  id                          uuid primary key default gen_random_uuid(),
  instance_id                 uuid not null references student_assignment_instances(id) on delete cascade,
  question_id                 uuid not null references questions(id) on delete cascade,
  position                    integer not null,
  timer_seconds               integer,          -- null for coding
  time_started_at             timestamptz,
  time_expired_at             timestamptz,
  unique (instance_id, question_id)
);
create index if not exists idx_sqi_instance on student_question_instances(instance_id);

create table if not exists answers (
  id                      uuid primary key default gen_random_uuid(),
  student_question_id     uuid not null references student_question_instances(id) on delete cascade,
  answer_text             text,               -- MCQ option id or short-answer text
  is_correct              boolean,
  score                   numeric,
  submitted_at            timestamptz not null default now(),
  auto_submitted          boolean not null default false  -- true if timer expiry forced submit
);
create index if not exists idx_answers_sqi on answers(student_question_id);

create table if not exists coding_submissions (
  id                      uuid primary key default gen_random_uuid(),
  student_question_id     uuid not null references student_question_instances(id) on delete cascade,
  code                    text not null,
  language                coding_language not null,
  is_final                boolean not null default false,   -- Submit vs Check
  check_number            integer,             -- 1..3 for "Check" attempts, null for final submit
  passed_test_cases       integer,
  total_test_cases        integer,
  score                   numeric,
  execution_log           text,
  status                  text not null default 'queued',   -- queued|running|passed|failed|error
  created_at              timestamptz not null default now()
);
create index if not exists idx_coding_submissions_sqi on coding_submissions(student_question_id);
create index if not exists idx_coding_submissions_final on coding_submissions(student_question_id, is_final);

create table if not exists violations (
  id                      uuid primary key default gen_random_uuid(),
  instance_id             uuid not null references student_assignment_instances(id) on delete cascade,
  type                    violation_type not null,
  detail                  text,
  occurred_at             timestamptz not null default now()
);
create index if not exists idx_violations_instance on violations(instance_id);

-- ---------------------------------------------------------------------
-- 9. RESULTS / ANALYTICS (derived — store minimal, compute the rest)
-- ---------------------------------------------------------------------
-- assignment_results caches the final per-student summary so heavy joins
-- aren't re-run on every dashboard view. Rebuilt/updated on submission,
-- never treated as the sole source of truth (answers/coding_submissions are).
create table if not exists assignment_results (
  id                  uuid primary key default gen_random_uuid(),
  instance_id         uuid not null unique references student_assignment_instances(id) on delete cascade,
  assignment_id       uuid not null references assignments(id) on delete cascade,
  student_id          uuid not null references students(id) on delete cascade,
  total_score         numeric not null,
  max_score           numeric not null,
  percentage          numeric generated always as (
    case when max_score > 0 then round((total_score / max_score) * 100, 2) else 0 end
  ) stored,
  mcq_score           numeric default 0,
  short_answer_score  numeric default 0,
  coding_score        numeric default 0,
  time_taken_seconds  integer,
  computed_at         timestamptz not null default now()
);
create index if not exists idx_assignment_results_assignment on assignment_results(assignment_id);
create index if not exists idx_assignment_results_student on assignment_results(student_id);

-- Leaderboard is DERIVED at query time from assignment_results (ranked),
-- respecting the result_buffer window. No separate stored ranking table
-- needed for V1; kept as a view for convenience.
create or replace view leaderboard_view as
select
  ar.assignment_id,
  ar.student_id,
  s.full_name as student_name,
  ar.total_score,
  ar.max_score,
  ar.percentage,
  ar.time_taken_seconds,
  rank() over (
    partition by ar.assignment_id
    order by ar.total_score desc, ar.time_taken_seconds asc
  ) as rank
from assignment_results ar
join students s on s.id = ar.student_id;

-- ---------------------------------------------------------------------
-- 10. QUESTION BANK REUSE LINKING (which bank questions came from where)
-- ---------------------------------------------------------------------
create table if not exists question_bank_usage (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null references questions(id) on delete cascade,
  assignment_id   uuid not null references assignments(id) on delete cascade,
  used_at         timestamptz not null default now(),
  unique (question_id, assignment_id)
);

-- ---------------------------------------------------------------------
-- 11. SYSTEM SETTINGS / ADMIN-CONFIGURED LIMITS
-- ---------------------------------------------------------------------
create table if not exists system_settings (
  key             text primary key,
  value           jsonb not null,
  updated_by      uuid references admins(id),
  updated_at      timestamptz not null default now()
);

insert into system_settings (key, value) values
  ('max_sets_per_assignment', '20'::jsonb),
  ('max_coding_checks', '3'::jsonb),
  ('default_timer_seconds', '45'::jsonb),
  ('min_ocr_quality_score', '0.55'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 12. AUDIT / SYSTEM LOGS
-- ---------------------------------------------------------------------
create table if not exists audit_logs (
  id              uuid primary key default gen_random_uuid(),
  actor_type      user_role,
  actor_id        uuid,
  action          text not null,             -- e.g. "login_success", "assignment_created"
  entity_type     text,
  entity_id       uuid,
  metadata        jsonb default '{}'::jsonb,
  ip_address      text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_audit_logs_actor on audit_logs(actor_type, actor_id);
create index if not exists idx_audit_logs_created on audit_logs(created_at desc);

create table if not exists ai_usage_logs (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid references assignments(id) on delete set null,
  lecturer_id     uuid references lecturers(id),
  operation       text not null,              -- generate_questions | validate_question | ocr
  model           text,
  prompt_tokens   integer,
  completion_tokens integer,
  status          text not null default 'success',  -- success|failed|retried
  error_message   text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ai_usage_logs_created on ai_usage_logs(created_at desc);

-- ---------------------------------------------------------------------
-- 13. UPDATED_AT TRIGGER HELPER
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  for t in select unnest(array[
    'admins','lecturers','students','subjects','questions','assignments','source_documents'
  ]) loop
    execute format(
      'drop trigger if exists trg_set_updated_at on %I; create trigger trg_set_updated_at before update on %I for each row execute function set_updated_at();',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 14. ROW LEVEL SECURITY
-- Backend uses the Supabase service role key (bypasses RLS) and enforces
-- authorization in the FastAPI layer, per the spec's security section.
-- RLS is enabled here as defense-in-depth in case anon/public keys are
-- ever used directly; policies default-deny.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;
-- No permissive policies are added: only the service role (which bypasses
-- RLS) can read/write. All application access must go through the backend.

-- =====================================================================
-- END OF SCHEMA
-- =====================================================================
