# AI Class Assignment Platform — V1

A platform where lecturers upload class-material PDFs and build assignments
(manual / AI-generated / hybrid questions), students get individualized
question sets, answers are auto-evaluated, and lecturers/admins get
analytics. Built against the master spec's fixed stack:

- **Frontend:** plain HTML / CSS / JavaScript (no build step, hash-routed SPA per role)
- **Backend:** Python + FastAPI
- **Database:** Supabase PostgreSQL
- **File storage:** Supabase Storage
- **Hosting:** Railway (single Docker service)
- **AI:** Gemini Flash (server-side only)
- **Code execution:** external isolated sandbox (never in-process)

---

## 1. What's fully implemented vs. what needs your infrastructure

Everything in the spec has a real, working code path. Two pieces call out
to infrastructure only you can provision (a Gemini key and a code-execution
sandbox), and are built against clean, swappable interfaces so wiring them
up is a config change, not a rewrite:

| Area | Status |
|---|---|
| Auth (3 roles), JWT sessions, password hashing, admin-triggered reset | ✅ Working |
| Admin: semesters, sections, lecturers, students (incl. bulk CSV), settings, system analytics | ✅ Working |
| Lecturer: semester→section→subject hierarchy, subject creation, profile edit | ✅ Working |
| Student auto-enrollment by semester+section (derived view, no duplication) | ✅ Working |
| PDF upload → readability check → text extraction, OCR fallback, quality gating | ✅ Working (needs `tesseract-ocr`, installed in the Docker image) |
| Compact knowledge-representation extraction & storage | ✅ Working — **calls Gemini**, needs `GEMINI_API_KEY` |
| Assignment creation, manual/AI/hybrid question counts, validation of counts | ✅ Working |
| Manual question entry (MCQ/short-answer/coding) inserted into every set | ✅ Working |
| AI question generation (structured JSON), per-set variation, bounded validation/regeneration | ✅ Working — **calls Gemini**, needs `GEMINI_API_KEY` |
| Question bank (per-lecturer, reusable, never shared) | ✅ Working |
| Randomized/balanced student↔set distribution, per-student question shuffle | ✅ Working |
| MCQ/short-answer local evaluation (no AI per answer) | ✅ Working |
| Server-enforced timers, one-submit-per-question, one-attempt-per-assignment | ✅ Working |
| Coding editor + Check(≤3)/Submit flow, hidden vs. sample test cases | ✅ Working — **calls your sandbox**, needs `SANDBOX_API_URL`/`SANDBOX_API_KEY` |
| Violation/proctoring event logging (tab switch, blur) | ✅ Working |
| Results, leaderboard (buffered reveal), lecturer analytics, Excel archive | ✅ Working |
| Caching (Redis or in-process fallback), structured logging, centralized error handling | ✅ Working |
| Row-level security (default-deny) + backend-enforced authorization | ✅ Working |

**Why AI and sandbox are external calls, not bundled code:** the spec is
explicit that the FastAPI process must never execute student code directly,
and that the AI key must be a server env var behind a swappable provider.
There's no safe way to "finish" those without you choosing real providers
(see §4 and §5 below for exactly what to plug in).

---

## 2. Architecture

```
platform/
├── schema.sql                # full DB schema — run once against Supabase
├── requirements.txt
├── Dockerfile                 # builds backend + frontend into one image
├── railway.json                # Railway deploy config
├── .env.example
├── backend/
│   └── app/
│       ├── main.py             # FastAPI app, middleware, router mounting, static frontend mount
│       ├── core/
│       │   ├── config.py       # env-var settings (pydantic-settings)
│       │   ├── database.py     # async SQLAlchemy engine/session
│       │   ├── security.py     # bcrypt hashing + JWT
│       │   ├── deps.py         # current-user + role-guard FastAPI dependencies
│       │   ├── cache.py        # Redis or in-process TTL cache, same interface
│       │   ├── errors.py       # AppError hierarchy + centralized exception handlers
│       │   └── logging_config.py  # structured JSON logs + request-id correlation
│       ├── routers/            # one file per concern — auth, admin, lecturer, student,
│       │                       # assignments, analytics, archive
│       ├── services/
│       │   ├── pdf_processing.py     # readability check → extract/OCR → knowledge map
│       │   ├── ai_generation.py      # Gemini calls: extract_knowledge / generate / validate
│       │   ├── generation_pipeline.py # orchestrates manual+AI question assembly per set
│       │   ├── set_distribution.py    # randomized balanced student↔set + shuffle
│       │   ├── evaluation.py          # local MCQ/short-answer scoring
│       │   ├── sandbox_client.py      # HTTP calls to your external code sandbox
│       │   └── storage_client.py      # Supabase Storage upload/download
│       ├── schemas/            # Pydantic request/response models
│       └── utils/db_helpers.py # parameterized raw-SQL helpers (SQL-injection safe)
└── frontend/
    ├── index.html               # shared login (role tabs: student/lecturer/admin)
    ├── shared/css/styles.css    # single design system used by all three apps
    ├── shared/js/api.js         # fetch wrapper: attaches JWT, normalizes errors
    ├── shared/js/router.js      # tiny hash router (no build step, bookmarkable routes)
    ├── student/  (index.html + app.js)  # subjects → assignments → exam-taking → results
    ├── lecturer/ (index.html + app.js)  # semester→section→subject → PDF/assignment builder → analytics
    └── admin/    (index.html + app.js)  # overview, semesters/sections, lecturers, students, settings
```

### Why this shape
- **Store once, derive many ways:** `assignment_results` caches the expensive
  per-student rollup; the leaderboard and analytics are views/queries over
  it, never a second hand-maintained source of truth. `subject_students` is
  a SQL view (live semester+section match), not a copied membership table.
- **Authorization lives in the backend, not the frontend.** Every router
  re-checks subject/assignment ownership server-side (`_assert_owns_subject`,
  etc.) — hiding a button in JS is never treated as security.
- **Replaceable modules.** `ai_generation.py` and `sandbox_client.py` are the
  only files that know about Gemini or your sandbox provider; swapping either
  later means touching one file, not the routers or pipeline.
- **No AI calls on the student's critical path.** MCQ/short-answer grading
  is local (`evaluation.py`); coding is judged by test-case comparison via
  the sandbox, not by asking the model to "grade" code.

---

## 3. Database — running `schema.sql`

1. Create a Supabase project.
2. Open **SQL Editor** in the Supabase dashboard, paste the contents of
   `schema.sql`, and run it. (Or via `psql`: `psql "$DATABASE_URL" -f schema.sql`.)
3. It creates all enums, tables, indexes, the `subject_students` and
   `leaderboard_view` views, a `set_updated_at` trigger, seed rows in
   `system_settings`, and enables RLS default-deny on every table (the
   backend uses the Supabase **service role key**, which bypasses RLS —
   RLS here is defense-in-depth if anon keys are ever used directly).
4. In **Storage**, create a bucket named `assignment-pdfs` (or set
   `SUPABASE_STORAGE_BUCKET` to whatever you name it) — private, not public.
5. Create your one Super Admin row manually (V1 has no self-serve admin
   signup, per spec):
   ```sql
   -- Generate a bcrypt hash for your password first (see note below), then:
   insert into admins (username, password_hash, full_name)
   values ('admin', '<bcrypt-hash>', 'Super Admin');
   ```
   Easiest way to get a bcrypt hash locally:
   ```bash
   python3 -c "from passlib.context import CryptContext; print(CryptContext(schemes=['bcrypt']).hash('your-password'))"
   ```

The schema is idempotent-ish (`if not exists` / `do $$ ... exception when
duplicate_object`), so re-running it is safe if you need to.

---

## 4. Configuring AI generation (Gemini)

1. Get a Gemini API key from Google AI Studio.
2. Set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, default `gemini-flash`)
   as a **Railway environment variable** — never in frontend code, never in
   the admin UI, per spec.
3. That's it — `ai_generation.py` picks it up via `core/config.py`. If the
   key is missing, AI/hybrid assignment creation fails cleanly with an
   `AIUnavailableError` and the assignment is saved as **Draft**, matching
   the spec's "on persistent AI failure, save assignment as Draft" rule.

## 5. Configuring the code-execution sandbox

The FastAPI process **never** runs student code. `services/sandbox_client.py`
expects an external HTTP service with Judge0/Piston-style semantics
(`POST /execute` with `{language, source_code, stdin, timeout_seconds}` →
`{stdout, stderr, exit_code, timed_out}`). Options:

- **Self-hosted Judge0** (Docker Compose, isolated via its own sandboxing) — recommended for full control.
- **Piston** (open-source, easy to self-host) — swap the endpoint shape in `sandbox_client.py` if needed.
- **A managed code-execution API** — set `SANDBOX_API_URL` / `SANDBOX_API_KEY` accordingly.

Whichever you pick, deploy it as its own isolated service (its own
container/VM) — never inside the FastAPI app's process or container.

---

## 6. Local development

```bash
# 1. Backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r ../requirements.txt
cp ../.env.example .env   # fill in SUPABASE_URL, DATABASE_URL, JWT_SECRET, etc.
uvicorn app.main:app --reload --port 8000
```

By default `app.main` mounts `FRONTEND_DIR` (`/app/frontend` in Docker) as
static files at `/`. For local dev without Docker, either:

- Run `export FRONTEND_DIR=$(pwd)/../frontend` before starting uvicorn so
  FastAPI serves the frontend too (visit `http://localhost:8000`), **or**
- Serve `frontend/` separately (`python3 -m http.server 5500` from the
  `frontend/` folder) and add `<script>window.API_BASE = "http://localhost:8000/api";</script>`
  before `api.js` loads in each `index.html`. Also set `ALLOWED_ORIGINS` in
  `.env` to `http://localhost:5500` for CORS.

Login screen: `http://localhost:8000/index.html` (or `5500` if run separately).

---

## 7. Deploying to Railway

This repo is one Docker service that serves both the API (`/api/*`) and
the static frontend (`/`), which keeps the deploy simple and avoids CORS
entirely in production.

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**. Railway detects
   the `Dockerfile` and `railway.json` automatically.
3. Add environment variables under **Variables** (mirror `.env.example`):
   `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_STORAGE_BUCKET`, `DATABASE_URL`, `GEMINI_API_KEY`,
   `SANDBOX_API_URL`, `SANDBOX_API_KEY`, `REDIS_URL` (optional — leave
   blank to use the built-in in-process cache), `ENV=production`,
   `ALLOWED_ORIGINS` (can stay `*` since frontend and API now share an origin).
4. (Optional) Add a Railway Redis plugin and point `REDIS_URL` at it once
   traffic justifies it — the app runs fine without it in V1.
5. Deploy. Railway's health check hits `/api/health` (configured in
   `railway.json`).
6. Run `schema.sql` against your Supabase project (§3) **before** first use.
7. Visit the deployed URL → `/index.html` to sign in as Admin and start
   creating semesters/sections/lecturers.

### Scaling notes for later
- Swap `ai_generation.py`'s provider or `sandbox_client.py`'s endpoint
  without touching any router.
- `system_settings` (e.g. `max_sets_per_assignment`) is admin-editable at
  runtime from the Admin UI — no redeploy needed to change limits.
- HOD/advanced roles are explicitly out of scope for V1 per the spec.

---

## 8. Key design decisions / assumptions (per spec §0: "document briefly")

- **Sandbox API shape:** assumed a Judge0/Piston-style HTTP contract since
  the spec left the specific provider unspecified. See §5 to point it at
  your actual choice.
- **Short-answer matching:** supports `exact_ci` (case-insensitive exact),
  `contains`, and `regex` per accepted answer, chosen for simplicity/speed
  without an AI call, per spec's "does not call AI" rule for this path.
  Lecturers can add multiple accepted answers/variants per question.
- **Bulk student upload:** implemented as CSV (`register_number, full_name,
  password, semester_id, section_id`) since the spec said "bulk upload"
  without specifying a format.
- **Question regeneration bound:** capped at 2 regeneration attempts per
  invalid AI question before it's dropped from the set, to keep AI cost
  bounded ("no unnecessary AI calls").
- **Result reveal:** both the student result endpoint and the leaderboard
  respect `deadline_at + result_buffer_seconds` before showing scores.

## 9. What to build next (natural V2 extensions, intentionally out of scope here)
- HOD/advanced roles (explicitly post-V1 per spec).
- Multi-provider AI failover.
- Real-time proctoring (webcam/face-count) — `violation_type` already has an
  `multiple_faces` slot reserved in the schema for this.
- Native mobile apps (current frontend is responsive/mobile-first web).
