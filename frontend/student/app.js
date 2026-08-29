// -------------------------------------------------------------------------
// Student app. Route map:
//   #dashboard                          -> list of enrolled subjects
//   #subject/:subjectId                 -> assignments for that subject
//   #assignment/:assignmentId/take      -> exam-taking screen
//   #assignment/:assignmentId/result    -> own result
//   #assignment/:assignmentId/leaderboard -> class ranking (post result-buffer)
// -------------------------------------------------------------------------

if (!Auth.isLoggedIn() || Auth.role() !== "student") {
  window.location.href = "../index.html";
}
document.getElementById("userPill").textContent = Auth.name();

function setCrumb(text) { document.getElementById("crumb").innerHTML = `<h2>${text}</h2>`; }
function loadingBlock() { return `<div class="loading"><div class="spinner"></div>Loading…</div>`; }
function errorBlock(err) { return `<div class="error-banner">${err.message || "Something went wrong."}</div>`; }

// ---------------------------------------------------------------- dashboard
async function renderDashboard(_, outlet) {
  setCrumb("My Subjects");
  outlet.innerHTML = loadingBlock();
  try {
    const subjects = await Api.get("/student/subjects");
    if (!subjects.length) {
      outlet.innerHTML = `<div class="empty-state"><h3>No subjects yet</h3>
        <p>You'll see subjects here once you're enrolled for your current semester and section.</p></div>`;
      return;
    }
    outlet.innerHTML = `<div class="grid grid-2">` + subjects.map(s => `
      <div class="card" style="cursor:pointer" onclick="Router.go('subject/${s.id}')">
        <h3>${s.name}</h3>
        <p style="color:var(--ink-soft); font-size:.88rem; margin:0;">${s.description || "No description."}</p>
        <p style="color:var(--ink-soft); font-size:.8rem; margin-top:10px;">Taught by ${s.lecturer_name}</p>
      </div>`).join("") + `</div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------------ subject page
async function renderSubject({ subjectId }, outlet) {
  setCrumb("Assignments");
  outlet.innerHTML = loadingBlock();
  try {
    const assignments = await Api.get(`/student/subjects/${subjectId}/assignments`);
    if (!assignments.length) {
      outlet.innerHTML = `<div class="empty-state"><h3>No assignments yet</h3></div>`;
      return;
    }
    outlet.innerHTML = assignments.map(a => {
      const badge = statusBadge(a.my_status);
      const action = a.my_status === "submitted"
        ? `<button class="btn secondary" onclick="Router.go('assignment/${a.id}/result')">View Result</button>`
        : `<button class="btn" onclick="Router.go('assignment/${a.id}/take')">
            ${a.my_status === "in_progress" ? "Resume" : "Start"}</button>`;
      return `<div class="card" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <h3 style="margin-bottom:4px;">${a.title}</h3>
          <div style="font-size:.8rem; color:var(--ink-soft);">
            Deadline: ${new Date(a.deadline_at).toLocaleString()} ${badge}
          </div>
        </div>
        ${action}
      </div>`;
    }).join("");
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

function statusBadge(status) {
  const map = {
    not_started: ['neutral', 'Not started'], in_progress: ['warn', 'In progress'],
    submitted: ['ok', 'Submitted'], expired: ['err', 'Expired'],
  };
  const [cls, label] = map[status] || ['neutral', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// -------------------------------------------------------------- exam state
let examState = null; // { assignmentId, questions, index, timerHandle, violationsBound }

async function renderExam({ assignmentId }, outlet) {
  setCrumb("Assignment");
  outlet.innerHTML = loadingBlock();
  try {
    const attempt = await Api.post(`/student/assignments/${assignmentId}/start`);
    examState = { assignmentId, questions: attempt.questions, index: 0, answered: new Set() };
    attempt.questions.forEach(q => { if (q.type !== "coding" && q._answered) examState.answered.add(q.student_question_id); });
    bindViolationTracking(assignmentId);
    renderQuestion(outlet);
  } catch (err) {
    outlet.innerHTML = errorBlock(err);
  }
}

function bindViolationTracking(assignmentId) {
  if (examState.violationsBound) return;
  examState.violationsBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      Api.post(`/student/assignments/${assignmentId}/violations`, { type: "tab_switch" }).catch(() => {});
    }
  });
  window.addEventListener("blur", () => {
    Api.post(`/student/assignments/${assignmentId}/violations`, { type: "window_blur" }).catch(() => {});
  });
}

function renderQuestion(outlet) {
  const { questions, index } = examState;
  const q = questions[index];
  clearInterval(examState.timerHandle);

  const nav = `<div class="question-nav">` + questions.map((qq, i) => `
      <div class="qnav-dot ${examState.answered.has(qq.student_question_id) ? 'answered' : ''} ${i === index ? 'current' : ''}"
           onclick="jumpTo(${i})">${i + 1}</div>`).join("") + `</div>`;

  let body = "";
  if (q.type === "mcq") {
    body = `<div class="question-card card">
      <h3>Q${index + 1}. ${escapeHtml(q.prompt)}</h3>
      <div id="optionsList">
        ${q.options.map(o => `<div class="option-row" data-oid="${o.id}" onclick="selectOption('${o.id}')">
          <span>${escapeHtml(o.option_text)}</span></div>`).join("")}
      </div>
      <button class="btn" style="margin-top:10px;" onclick="submitMcqOrShort()">Submit Answer</button>
    </div>`;
  } else if (q.type === "short_answer") {
    body = `<div class="question-card card">
      <h3>Q${index + 1}. ${escapeHtml(q.prompt)}</h3>
      <div class="field"><input id="shortAnswerInput" type="text" placeholder="Your answer" /></div>
      <button class="btn" onclick="submitMcqOrShort()">Submit Answer</button>
    </div>`;
  } else {
    const sample = (q.sample_test_cases || []).map(tc =>
      `<div style="font-family:var(--font-mono); font-size:.8rem; margin-bottom:6px;">
         Input: ${escapeHtml(tc.input_data || "")} → Expected: ${escapeHtml(tc.expected_output || "")}</div>`).join("");
    body = `<div class="question-card card">
      <h3>Q${index + 1}. ${escapeHtml(q.prompt)}</h3>
      <p style="font-size:.85rem; color:var(--ink-soft);">${escapeHtml(q.expected_behavior || "")}</p>
      ${sample ? `<div style="margin:10px 0;"><strong style="font-size:.8rem;">Sample cases</strong>${sample}</div>` : ""}
      <div class="field">
        <label>Language</label>
        <select id="codeLang">
          <option value="python" ${q.coding_language === "python" ? "selected" : ""}>Python</option>
          <option value="java" ${q.coding_language === "java" ? "selected" : ""}>Java</option>
          <option value="javascript" ${q.coding_language === "javascript" ? "selected" : ""}>JavaScript</option>
        </select>
      </div>
      <textarea class="code-editor" id="codeEditor" spellcheck="false"
        onpaste="return false" oncopy="return false" oncut="return false"></textarea>
      <div style="display:flex; gap:10px; margin-top:10px; align-items:center;">
        <button class="btn secondary" onclick="runCodingCheck()">Check (<span id="checksLeft">3</span> left)</button>
        <button class="btn" onclick="submitCoding()">Submit Final</button>
        <span id="codeResult" style="font-size:.82rem;"></span>
      </div>
    </div>`;
  }

  const timerBlock = q.timer_seconds
    ? `<div class="timer-pill" id="timerPill">--:--</div>`
    : `<span class="badge neutral">No timer — code check limit applies</span>`;

  outlet.innerHTML = `
    <div class="exam-shell">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <div style="font-size:.85rem; color:var(--ink-soft);">Question ${index + 1} of ${questions.length}</div>
        ${timerBlock}
      </div>
      ${nav}
      ${body}
      <div style="display:flex; justify-content:space-between; margin-top:10px;">
        <button class="btn secondary" ${index === 0 ? "disabled" : ""} onclick="jumpTo(${index - 1})">Back</button>
        ${index === questions.length - 1
          ? `<button class="btn" onclick="finishExam()">Finish & Submit Assignment</button>`
          : `<button class="btn secondary" onclick="jumpTo(${index + 1})">Next</button>`}
      </div>
    </div>`;

  if (q.type === "coding") loadCodingChecksRemaining(q.student_question_id);
  if (q.timer_seconds) startTimer(q);
}

function startTimer(q) {
  let remaining = q.timer_seconds;
  const pill = document.getElementById("timerPill");
  const tick = () => {
    const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    if (pill) {
      pill.textContent = `${mm}:${ss}`;
      pill.classList.toggle("low", remaining <= 10);
    }
    if (remaining <= 0) {
      clearInterval(examState.timerHandle);
      autoSubmitOnExpiry();
      return;
    }
    remaining -= 1;
  };
  tick();
  examState.timerHandle = setInterval(tick, 1000);
}

async function autoSubmitOnExpiry() {
  const q = examState.questions[examState.index];
  if (examState.answered.has(q.student_question_id)) return;
  try {
    if (q.type === "mcq") {
      const selected = document.querySelector(".option-row.selected");
      await Api.post("/student/answers", { student_question_id: q.student_question_id, answer_text: selected?.dataset.oid || "" });
    } else {
      const val = document.getElementById("shortAnswerInput")?.value || "";
      await Api.post("/student/answers", { student_question_id: q.student_question_id, answer_text: val });
    }
    examState.answered.add(q.student_question_id);
  } catch (e) { /* server enforces the real deadline regardless */ }
  if (examState.index < examState.questions.length - 1) jumpTo(examState.index + 1);
}

function jumpTo(i) {
  examState.index = i;
  renderQuestion(document.getElementById("outlet"));
}

function selectOption(optionId) {
  document.querySelectorAll(".option-row").forEach(el => el.classList.toggle("selected", el.dataset.oid === optionId));
}

async function submitMcqOrShort() {
  const q = examState.questions[examState.index];
  const answer_text = q.type === "mcq"
    ? document.querySelector(".option-row.selected")?.dataset.oid
    : document.getElementById("shortAnswerInput").value;
  if (!answer_text) { alert("Please provide an answer before submitting."); return; }
  try {
    await Api.post("/student/answers", { student_question_id: q.student_question_id, answer_text });
    examState.answered.add(q.student_question_id);
    if (examState.index < examState.questions.length - 1) jumpTo(examState.index + 1);
    else renderQuestion(document.getElementById("outlet"));
  } catch (err) { alert(err.message); }
}

async function loadCodingChecksRemaining(_sqid) {
  // Server enforces the real limit; this is just a UI hint reset per question view.
  document.getElementById("checksLeft").textContent = "3";
}

async function runCodingCheck() {
  const q = examState.questions[examState.index];
  const resultEl = document.getElementById("codeResult");
  resultEl.textContent = "Running…";
  try {
    const result = await Api.post("/student/coding/check", {
      student_question_id: q.student_question_id,
      code: document.getElementById("codeEditor").value,
      language: document.getElementById("codeLang").value,
    });
    resultEl.textContent = `${result.passed}/${result.total} sample cases passed`;
    const left = document.getElementById("checksLeft");
    left.textContent = Math.max(0, parseInt(left.textContent, 10) - 1);
  } catch (err) { resultEl.textContent = err.message; }
}

async function submitCoding() {
  const q = examState.questions[examState.index];
  const resultEl = document.getElementById("codeResult");
  if (!confirm("Submit final code for this question? This cannot be undone.")) return;
  try {
    const result = await Api.post("/student/coding/submit", {
      student_question_id: q.student_question_id,
      code: document.getElementById("codeEditor").value,
      language: document.getElementById("codeLang").value,
      is_final: true,
    });
    examState.answered.add(q.student_question_id);
    resultEl.textContent = `Submitted — ${result.passed}/${result.total} cases passed.`;
  } catch (err) { resultEl.textContent = err.message; }
}

async function finishExam() {
  if (!confirm("Submit the entire assignment now? You won't be able to make further changes.")) return;
  try {
    await Api.post(`/student/assignments/${examState.assignmentId}/submit`);
    Router.go(`assignment/${examState.assignmentId}/result`);
  } catch (err) { alert(err.message); }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ------------------------------------------------------------------ result
async function renderResult({ assignmentId }, outlet) {
  setCrumb("Result");
  outlet.innerHTML = loadingBlock();
  try {
    const result = await Api.get(`/student/assignments/${assignmentId}/result`);
    if (result.status === "pending") {
      outlet.innerHTML = `<div class="empty-state"><h3>Results pending</h3><p>${result.message}</p></div>`;
      return;
    }
    outlet.innerHTML = `
      <div class="grid grid-3">
        <div class="card stat"><div class="value">${result.total_score}/${result.max_score}</div><div class="label">Score</div></div>
        <div class="card stat"><div class="value">${result.percentage}%</div><div class="label">Percentage</div></div>
        <div class="card stat"><div class="value">${result.time_taken_seconds ?? "—"}s</div><div class="label">Time Taken</div></div>
      </div>
      <button class="btn secondary" onclick="Router.go('assignment/${assignmentId}/leaderboard')">View Leaderboard</button>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function renderLeaderboard({ assignmentId }, outlet) {
  setCrumb("Leaderboard");
  outlet.innerHTML = loadingBlock();
  try {
    const rows = await Api.get(`/analytics/assignments/${assignmentId}/leaderboard`);
    if (rows.status === "pending") {
      outlet.innerHTML = `<div class="empty-state"><h3>Leaderboard locked</h3><p>${rows.message}</p></div>`;
      return;
    }
    outlet.innerHTML = `<table>
      <thead><tr><th>Rank</th><th>Student</th><th>Score</th><th>%</th><th>Time</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${r.rank}</td><td>${escapeHtml(r.student_name)}</td>
        <td>${r.total_score}/${r.max_score}</td><td>${r.percentage}%</td>
        <td>${r.time_taken_seconds ?? "—"}s</td></tr>`).join("")}</tbody></table>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------------------ router
Router.register("dashboard", renderDashboard);
Router.register("subject/:subjectId", renderSubject);
Router.register("assignment/:assignmentId/take", renderExam);
Router.register("assignment/:assignmentId/result", renderResult);
Router.register("assignment/:assignmentId/leaderboard", renderLeaderboard);
Router.init(document.getElementById("outlet"), {
  notFound: (outlet) => { Router.go("dashboard"); },
});
if (!location.hash) Router.go("dashboard");
