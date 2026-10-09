// -------------------------------------------------------------------------
// Student app. Routes:
//   #dashboard                              enrolled subjects
//   #subject/:subjectId                     assignments for a subject
//   #assignment/:assignmentId/take          the exam screen
//   #assignment/:assignmentId/result        own result
//   #assignment/:assignmentId/leaderboard   class ranking (after the results delay)
// Helpers (escapeHtml, setCrumb, loadingBlock, errorBlock, notify, tableHtml)
// come from shared/js/ui.js.
// -------------------------------------------------------------------------

if (!Auth.isLoggedIn() || Auth.role() !== "student") {
  window.location.href = "../index.html";
}

// ---------------------------------------------------------------- dashboard
async function renderDashboard(_, outlet) {
  setCrumb("My subjects", "Everything you're enrolled in this semester.");
  outlet.innerHTML = loadingBlock();
  try {
    const subjects = await Api.get("/student/subjects");
    if (!subjects.length) {
      outlet.innerHTML = `<div class="empty-state"><h3>No subjects yet</h3>
        <p>They show up here once you're enrolled for this semester and section.</p></div>`;
      return;
    }
    outlet.innerHTML = `<div class="grid tiles">` + subjects.map(s => `
      <a class="tile" href="#subject/${s.id}">
        <h3>${escapeHtml(s.name)}</h3>
        <p class="meta">${escapeHtml(s.description || "No description")}</p>
        <p class="meta" style="margin-top:10px;">Taught by ${escapeHtml(s.lecturer_name)}</p>
      </a>`).join("") + `</div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------------ subject page
async function renderSubject({ subjectId }, outlet) {
  setCrumb("Assignments", null, { href: "#dashboard", label: "My subjects" });
  outlet.innerHTML = loadingBlock();
  try {
    const assignments = await Api.get(`/student/subjects/${subjectId}/assignments`);
    if (!assignments.length) {
      outlet.innerHTML = `<div class="empty-state"><h3>Nothing set yet</h3><p>Your lecturer hasn't published an assignment for this subject.</p></div>`;
      return;
    }
    outlet.innerHTML = assignments.map(a => {
      const action = a.my_status === "submitted"
        ? `<a class="btn secondary" href="#assignment/${a.id}/result">View result</a>`
        : `<a class="btn" href="#assignment/${a.id}/take">${a.my_status === "in_progress" ? "Resume" : "Start"}</a>`;
      return `<div class="card between">
        <div>
          <h3 style="margin-bottom:4px;">${escapeHtml(a.title)}</h3>
          <div class="small muted">Due ${escapeHtml(new Date(a.deadline_at).toLocaleString())} &nbsp;${statusBadge(a.my_status)}</div>
        </div>
        ${action}
      </div>`;
    }).join("");
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

function statusBadge(status) {
  const map = {
    not_started: ["neutral", "Not started"], in_progress: ["warn", "In progress"],
    submitted: ["ok", "Submitted"], expired: ["err", "Expired"],
  };
  const [cls, label] = map[status] || ["neutral", status];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

// -------------------------------------------------------------- exam state
let examState = null; // { assignmentId, questions, index, timerHandle, violationsBound, answered }

async function renderExam({ assignmentId }, outlet) {
  setCrumb("Assignment");
  outlet.innerHTML = loadingBlock();
  try {
    const attempt = await Api.post(`/student/assignments/${assignmentId}/start`);
    examState = { assignmentId, questions: attempt.questions, index: 0, answered: new Set() };
    attempt.questions.forEach(q => { if (q.type !== "coding" && q._answered) examState.answered.add(q.student_question_id); });
    bindViolationTracking(assignmentId);
    renderQuestion(outlet);
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

function bindViolationTracking(assignmentId) {
  if (examState.violationsBound) return;
  examState.violationsBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) Api.post(`/student/assignments/${assignmentId}/violations`, { type: "tab_switch" }).catch(() => {});
  });
  window.addEventListener("blur", () => {
    Api.post(`/student/assignments/${assignmentId}/violations`, { type: "window_blur" }).catch(() => {});
  });
}

function renderQuestion(outlet) {
  const { questions, index } = examState;
  const q = questions[index];
  clearInterval(examState.timerHandle);

  const nav = `<div class="question-nav" role="group" aria-label="Questions">` + questions.map((qq, i) => `
    <button type="button" class="qnav-dot ${examState.answered.has(qq.student_question_id) ? "answered" : ""} ${i === index ? "current" : ""}"
      aria-label="Question ${i + 1}${examState.answered.has(qq.student_question_id) ? ", answered" : ""}" onclick="jumpTo(${i})">${i + 1}</button>`).join("") + `</div>`;

  let body = "";
  if (q.type === "mcq") {
    body = `<div class="card">
      <p class="q-prompt">${index + 1}. ${escapeHtml(q.prompt)}</p>
      <div id="optionsList" role="radiogroup">
        ${q.options.map((o, oi) => `<div class="option-row" role="radio" tabindex="0" aria-checked="false" data-oid="${o.id}"
            onclick="selectOption('${o.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectOption('${o.id}')}">
          <span class="letter">${String.fromCharCode(65 + oi)}</span><span>${escapeHtml(o.option_text)}</span></div>`).join("")}
      </div>
      <button class="btn block" style="margin-top:10px;" onclick="submitMcqOrShort()">Submit answer</button>
    </div>`;
  } else if (q.type === "short_answer") {
    body = `<div class="card">
      <p class="q-prompt">${index + 1}. ${escapeHtml(q.prompt)}</p>
      <div class="field"><label for="shortAnswerInput" class="sr-only">Your answer</label>
        <input id="shortAnswerInput" type="text" placeholder="Your answer" autocomplete="off" autocapitalize="off" /></div>
      <button class="btn block" onclick="submitMcqOrShort()">Submit answer</button>
    </div>`;
  } else {
    const sample = (q.sample_test_cases || []).map(tc =>
      `<div class="sample">in: ${escapeHtml(tc.input_data || "")}<br>out: ${escapeHtml(tc.expected_output || "")}</div>`).join("");
    body = `<div class="card">
      <p class="q-prompt">${index + 1}. ${escapeHtml(q.prompt)}</p>
      <p class="small muted">${escapeHtml(q.expected_behavior || "")}</p>
      ${sample ? `<p class="label" style="margin-top:12px;">Sample cases</p>${sample}` : ""}
      <div class="field" style="margin-top:12px;"><label for="codeLang">Language</label>
        <select id="codeLang">${["python", "java", "javascript"].map(l =>
          `<option value="${l}" ${q.coding_language === l ? "selected" : ""}>${l[0].toUpperCase() + l.slice(1)}</option>`).join("")}</select></div>
      <textarea class="code-editor" id="codeEditor" spellcheck="false" aria-label="Code editor"
        onpaste="return false" oncopy="return false" oncut="return false"></textarea>
      <div class="cluster actions-stack" style="margin-top:10px;">
        <button class="btn secondary" onclick="runCodingCheck()">Check (<span id="checksLeft">3</span> left)</button>
        <button class="btn" onclick="submitCoding()">Submit final</button>
      </div>
      <p id="codeResult" class="small" style="margin:10px 0 0;" aria-live="polite"></p>
    </div>`;
  }

  const timerBlock = q.timer_seconds
    ? `<div class="timer-pill" id="timerPill" role="timer">--:--</div>`
    : `<span class="badge neutral">No timer</span>`;

  outlet.innerHTML = `
    <div class="exam">
      <div class="exam-bar"><span class="small muted">Question ${index + 1} of ${questions.length}</span>${timerBlock}</div>
      ${nav}
      ${body}
      <div class="exam-nav">
        <button class="btn secondary" ${index === 0 ? "disabled" : ""} onclick="jumpTo(${index - 1})">Back</button>
        ${index === questions.length - 1
          ? `<button class="btn blue" onclick="finishExam()">Finish and submit</button>`
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
    if (pill) { pill.textContent = `${mm}:${ss}`; pill.classList.toggle("low", remaining <= 10); }
    if (remaining <= 0) { clearInterval(examState.timerHandle); autoSubmitOnExpiry(); return; }
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
  } catch (e) { /* the server enforces the real deadline regardless */ }
  if (examState.index < examState.questions.length - 1) jumpTo(examState.index + 1);
}

function jumpTo(i) { examState.index = i; renderQuestion(document.getElementById("outlet")); }

function selectOption(optionId) {
  document.querySelectorAll(".option-row").forEach(el => {
    const on = el.dataset.oid === optionId;
    el.classList.toggle("selected", on);
    el.setAttribute("aria-checked", String(on));
  });
}

async function submitMcqOrShort() {
  const q = examState.questions[examState.index];
  const answer_text = q.type === "mcq"
    ? document.querySelector(".option-row.selected")?.dataset.oid
    : document.getElementById("shortAnswerInput").value;
  if (!answer_text) return notify("Put in an answer before you submit.", "error");
  try {
    await Api.post("/student/answers", { student_question_id: q.student_question_id, answer_text });
    examState.answered.add(q.student_question_id);
    if (examState.index < examState.questions.length - 1) jumpTo(examState.index + 1);
    else renderQuestion(document.getElementById("outlet"));
  } catch (err) { notify(err.message, "error"); }
}

async function loadCodingChecksRemaining(_sqid) {
  // The server enforces the real limit; this is only a hint that resets per view.
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
    resultEl.textContent = `${result.passed} of ${result.total} sample cases passed.`;
    const left = document.getElementById("checksLeft");
    left.textContent = Math.max(0, parseInt(left.textContent, 10) - 1);
  } catch (err) { resultEl.textContent = err.message; }
}

async function submitCoding() {
  const q = examState.questions[examState.index];
  const resultEl = document.getElementById("codeResult");
  if (!confirm("Submit this code as your final answer? You can't change it afterwards.")) return;
  try {
    const result = await Api.post("/student/coding/submit", {
      student_question_id: q.student_question_id,
      code: document.getElementById("codeEditor").value,
      language: document.getElementById("codeLang").value,
      is_final: true,
    });
    examState.answered.add(q.student_question_id);
    resultEl.textContent = `Submitted. ${result.passed} of ${result.total} cases passed.`;
  } catch (err) { resultEl.textContent = err.message; }
}

async function finishExam() {
  if (!confirm("Hand in the whole assignment now? You won't be able to change anything after this.")) return;
  try {
    await Api.post(`/student/assignments/${examState.assignmentId}/submit`);
    Router.go(`assignment/${examState.assignmentId}/result`);
  } catch (err) { notify(err.message, "error"); }
}

// ------------------------------------------------------------------ result
async function renderResult({ assignmentId }, outlet) {
  setCrumb("Your result");
  outlet.innerHTML = loadingBlock();
  try {
    const result = await Api.get(`/student/assignments/${assignmentId}/result`);
    if (result.status === "pending") {
      outlet.innerHTML = `<div class="empty-state"><h3>Not ready yet</h3><p>${escapeHtml(result.message)}</p></div>`;
      return;
    }
    outlet.innerHTML = `
      <div class="grid cols-3">
        <div class="card stat"><div class="value">${escapeHtml(result.total_score)}/${escapeHtml(result.max_score)}</div><div class="label">Score</div></div>
        <div class="card stat"><div class="value">${escapeHtml(result.percentage)}%</div><div class="label">Percentage</div></div>
        <div class="card stat"><div class="value">${escapeHtml(result.time_taken_seconds ?? "—")}${result.time_taken_seconds != null ? "s" : ""}</div><div class="label">Time taken</div></div>
      </div>
      <a class="btn secondary" href="#assignment/${assignmentId}/leaderboard">View leaderboard</a>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function renderLeaderboard({ assignmentId }, outlet) {
  setCrumb("Leaderboard", null, { href: `#assignment/${assignmentId}/result`, label: "Your result" });
  outlet.innerHTML = loadingBlock();
  try {
    const rows = await Api.get(`/analytics/assignments/${assignmentId}/leaderboard`);
    if (rows.status === "pending") {
      outlet.innerHTML = `<div class="empty-state"><h3>Not open yet</h3><p>${escapeHtml(rows.message)}</p></div>`;
      return;
    }
    outlet.innerHTML = tableHtml(
      [{ label: "Rank" }, { label: "Student" }, { label: "Score" }, { label: "%" }, { label: "Time" }],
      rows.map(r => [escapeHtml(r.rank), escapeHtml(r.student_name), `${escapeHtml(r.total_score)}/${escapeHtml(r.max_score)}`,
        `${escapeHtml(r.percentage)}%`, r.time_taken_seconds != null ? `${escapeHtml(r.time_taken_seconds)}s` : "—"]),
      `<div class="empty-state"><h3>No entries yet</h3></div>`);
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------------------ router
Router.register("dashboard", renderDashboard);
Router.register("subject/:subjectId", renderSubject);
Router.register("assignment/:assignmentId/take", renderExam);
Router.register("assignment/:assignmentId/result", renderResult);
Router.register("assignment/:assignmentId/leaderboard", renderLeaderboard);
Router.init(document.getElementById("outlet"), { notFound: () => { Router.go("dashboard"); } });
if (!location.hash) Router.go("dashboard");