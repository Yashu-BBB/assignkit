// -------------------------------------------------------------------------
// Lecturer app. Routes:
//   #semesters                          #create-subject
//   #semester/:semId/sections           #section/:secId/subjects
//   #subject/:subjectId                 #subject/:subjectId/new-assignment
//   #subject/:subjectId/question-bank   #assignment/:assignmentId/analytics
//   #profile
// Shared helpers (escapeHtml, setCrumb, loadingBlock, errorBlock, notify,
// tableHtml) come from shared/js/ui.js.
// -------------------------------------------------------------------------

if (!Auth.isLoggedIn() || Auth.role() !== "lecturer") {
  window.location.href = "../index.html";
}

// --------------------------------------------------------------- semesters
async function renderSemesters(_, outlet) {
  setCrumb("Your subjects", "Pick a semester to find the subjects you teach.");
  outlet.innerHTML = loadingBlock();
  try {
    const semesters = await Api.get("/lecturer/semesters");
    const newBtn = `<p><a class="btn" href="#create-subject">New subject</a></p>`;
    if (!semesters.length) {
      outlet.innerHTML = newBtn + `<div class="empty-state"><h3>Nothing here yet</h3>
        <p>Create your first subject: choose a semester and section, give it a name, and you're set.</p></div>`;
      return;
    }
    outlet.innerHTML = newBtn + `<div class="grid tiles">` + semesters.map(s => `
      <a class="tile" href="#semester/${s.id}/sections"><h3>${escapeHtml(s.name)}</h3><p class="meta">View sections</p></a>`).join("") + `</div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------- create a subject
// Browses ALL semesters/sections (not only ones already taught) so a lecturer
// can set up a first subject or add another.
let createSubjectState = { semesterId: null, sectionId: null };

async function renderCreateSubject(_, outlet) {
  setCrumb("New subject", "Three quick choices: semester, section, name.", { href: "#semesters", label: "Your subjects" });
  createSubjectState = { semesterId: null, sectionId: null };
  outlet.innerHTML = loadingBlock();
  try {
    const semesters = await Api.get("/lecturer/browse/semesters");
    if (!semesters.length) {
      outlet.innerHTML = `<div class="empty-state"><h3>No semesters yet</h3>
        <p>Ask your administrator to set up a semester and a section first.</p></div>`;
      return;
    }
    outlet.innerHTML = `
      <div class="card"><h3>1. Semester</h3>
        <div class="field"><label class="sr-only" for="cs_semester">Semester</label>
          <select id="cs_semester" onchange="onCreateSubjectSemesterChange()">
            <option value="">Choose a semester…</option>
            ${semesters.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}
          </select></div>
      </div>
      <div class="card" id="cs_sectionCard" hidden><h3>2. Section</h3>
        <div class="field"><label class="sr-only" for="cs_section">Section</label>
          <select id="cs_section" onchange="onCreateSubjectSectionChange()"></select></div>
      </div>
      <div class="card" id="cs_detailsCard" hidden><h3>3. Name it</h3>
        <div class="field"><label for="cs_name">Subject name</label><input id="cs_name" /></div>
        <div class="field"><label for="cs_desc">Description <span class="muted">(optional)</span></label><input id="cs_desc" /></div>
        <button class="btn" onclick="submitCreateSubject()">Create subject</button>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function onCreateSubjectSemesterChange() {
  const semesterId = document.getElementById("cs_semester").value;
  createSubjectState.semesterId = semesterId || null;
  const sectionCard = document.getElementById("cs_sectionCard");
  document.getElementById("cs_detailsCard").hidden = true;
  if (!semesterId) { sectionCard.hidden = true; return; }
  try {
    const sections = await Api.get(`/lecturer/browse/semesters/${semesterId}/sections`);
    document.getElementById("cs_section").innerHTML = `<option value="">Choose a section…</option>` +
      sections.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
    sectionCard.hidden = false;
  } catch (err) { notify(err.message, "error"); }
}

function onCreateSubjectSectionChange() {
  const sectionId = document.getElementById("cs_section").value;
  createSubjectState.sectionId = sectionId || null;
  document.getElementById("cs_detailsCard").hidden = !sectionId;
}

async function submitCreateSubject() {
  const name = document.getElementById("cs_name").value.trim();
  if (!name) return notify("Give the subject a name.", "error");
  if (!createSubjectState.sectionId) return notify("Choose a section first.", "error");
  try {
    const subject = await Api.post("/lecturer/subjects", {
      section_id: createSubjectState.sectionId, name,
      description: document.getElementById("cs_desc").value.trim() || null,
    });
    Router.go(`subject/${subject.id}`);
  } catch (err) { notify(err.message, "error"); }
}

async function renderSections({ semId }, outlet) {
  setCrumb("Sections", null, { href: "#semesters", label: "Your subjects" });
  outlet.innerHTML = loadingBlock();
  try {
    const sections = await Api.get(`/lecturer/semesters/${semId}/sections`);
    outlet.innerHTML = `<div class="grid tiles">` + sections.map(s => `
      <a class="tile" href="#section/${s.id}/subjects"><h3>Section ${escapeHtml(s.name)}</h3><p class="meta">View subjects</p></a>`).join("") + `</div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function renderSubjects({ secId }, outlet) {
  setCrumb("Subjects", null, { href: "#semesters", label: "Your subjects" });
  outlet.innerHTML = loadingBlock();
  try {
    const subjects = await Api.get(`/lecturer/sections/${secId}/subjects`);
    outlet.innerHTML = (subjects.length ? `<div class="grid tiles">${subjects.map(s => `
      <a class="tile" href="#subject/${s.id}"><h3>${escapeHtml(s.name)}</h3>
        <p class="meta">${escapeHtml(s.description || "No description")}</p></a>`).join("")}</div>` : "") + `
      <div class="card" style="margin-top:var(--gap);"><h3>Add a subject to this section</h3>
        <div class="field"><label for="newSubjectName">Subject name</label><input id="newSubjectName" /></div>
        <div class="field"><label for="newSubjectDesc">Description <span class="muted">(optional)</span></label><input id="newSubjectDesc" /></div>
        <button class="btn" onclick="createSubject('${secId}')">Add subject</button>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function createSubject(secId) {
  const name = document.getElementById("newSubjectName").value.trim();
  if (!name) return notify("Give the subject a name.", "error");
  try {
    await Api.post("/lecturer/subjects", {
      section_id: secId, name, description: document.getElementById("newSubjectDesc").value.trim() || null,
    });
    notify("Subject added.");
    renderSubjects({ secId }, document.getElementById("outlet"));
  } catch (err) { notify(err.message, "error"); }
}

// ----------------------------------------------------------- subject page
async function renderSubjectOverview({ subjectId }, outlet) {
  setCrumb("Subject", null, { href: "#semesters", label: "Your subjects" });
  outlet.innerHTML = loadingBlock();
  try {
    const [assignments, students] = await Promise.all([
      Api.get(`/assignments/subject/${subjectId}`),
      Api.get(`/lecturer/subjects/${subjectId}/students`),
    ]);
    outlet.innerHTML = `
      <div class="cluster" style="margin-bottom:var(--gap);">
        <a class="btn" href="#subject/${subjectId}/new-assignment">New assignment</a>
        <a class="btn secondary" href="#subject/${subjectId}/question-bank">Question bank</a>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h3>Assignments (${assignments.length})</h3>
          ${assignments.length ? `<ul class="rows">${assignments.map(a => `
            <li><span>${escapeHtml(a.title)} <span class="badge neutral">${escapeHtml(a.status)}</span></span>
              <a href="#assignment/${a.id}/analytics">Analytics →</a></li>`).join("")}</ul>`
            : `<p class="muted">No assignments yet. Make the first one with the button above.</p>`}
        </div>
        <div class="card">
          <h3>Students (${students.length})</h3>
          <p class="small muted">Taken from the semester and section, so there's nobody to add by hand.</p>
          <ul class="rows scroll-y">${students.map(s => `
            <li><span>${escapeHtml(s.full_name)}</span><span class="muted small">${escapeHtml(s.register_number)}</span></li>`).join("")}</ul>
        </div>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------ assignment builder
let manualQuestions = { mcq: [], short_answer: [], coding: [] };
let uploadedDocId = null;
let featureFlags = { pdf_upload: false, manual_coding: false };

async function renderNewAssignment({ subjectId }, outlet) {
  setCrumb("New assignment", "Set it up in three steps.", { href: `#subject/${subjectId}`, label: "Subject" });
  manualQuestions = { mcq: [], short_answer: [], coding: [] };
  uploadedDocId = null;
  outlet.innerHTML = loadingBlock();
  featureFlags = await Features.load();

  const pdfBlock = featureFlags.pdf_upload
    ? `<div class="field"><label for="pdfFile">PDF file</label><input type="file" id="pdfFile" accept="application/pdf" /></div>
       <button class="btn secondary" onclick="uploadPdf('${subjectId}')">Upload PDF</button>
       <div id="pdfStatus" class="small muted" style="margin-top:8px;" aria-live="polite"></div>`
    : `<div class="off">
         <button class="btn" type="button" disabled aria-disabled="true">Upload PDF</button>
         ${UNAVAILABLE_CHIP}
         <p>Uploading class material is switched off for now. You can still build and publish an assignment without it.</p>
       </div>`;

  outlet.innerHTML = `
    <div class="step"><div class="num">1</div>
      <div class="card"><h3>Class material <span class="muted small">(optional)</span></h3>${pdfBlock}</div></div>

    <div class="step"><div class="num">2</div>
      <div class="card">
        <h3>Settings</h3>
        <div class="field"><label for="a_title">Title</label><input id="a_title" /></div>

        <div class="field"><span class="label" id="modeLabel">How are the questions written?</span>
          <div class="seg" role="radiogroup" aria-labelledby="modeLabel">
            <label><input type="radio" name="a_mode" value="manual" checked onchange="onModeChange()" /><span>Manual</span></label>
            <label><input type="radio" name="a_mode" value="hybrid" onchange="onModeChange()" /><span>Hybrid</span></label>
            <label><input type="radio" name="a_mode" value="ai" onchange="onModeChange()" /><span>AI</span></label>
          </div>
          <span class="hint" id="modeHint"></span>
        </div>

        <div class="field"><label for="a_difficulty">Overall difficulty</label>
          <select id="a_difficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></div>

        <div class="field-row">
          <div class="field"><label for="a_total">Total questions</label><input id="a_total" type="number" inputmode="numeric" min="1" value="10" oninput="updateSum()" /></div>
          <div class="field"><label for="a_mcq">Multiple choice</label><input id="a_mcq" type="number" inputmode="numeric" min="0" value="5" oninput="updateSum()" /></div>
          <div class="field"><label for="a_sa">Short answer</label><input id="a_sa" type="number" inputmode="numeric" min="0" value="5" oninput="updateSum()" /></div>
          <div class="field"><label for="a_coding">Coding</label><input id="a_coding" type="number" inputmode="numeric" min="0" value="0" oninput="updateSum()" />
            <span class="hint" id="codingHint"></span></div>
        </div>
        <div class="sum" id="sumLine" role="status"></div>

        <div class="field-row">
          <div class="field"><label for="a_sets">Number of sets</label><input id="a_sets" type="number" inputmode="numeric" min="1" value="1" /></div>
          <div class="field"><label for="a_timer">Seconds per MCQ / short answer</label><input id="a_timer" type="number" inputmode="numeric" min="5" value="45" /></div>
          <div class="field"><label for="a_buffer">Results delay (seconds)</label><input id="a_buffer" type="number" inputmode="numeric" min="0" value="0" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="a_start">Opens</label><input id="a_start" type="datetime-local" /></div>
          <div class="field"><label for="a_deadline">Deadline</label><input id="a_deadline" type="datetime-local" /></div>
        </div>

        <div id="aiInstructions" hidden>
          <div class="field"><label for="a_gen_instr">General instructions for the AI <span class="muted">(optional)</span></label><textarea id="a_gen_instr"></textarea></div>
          <div class="field-row">
            <div class="field"><label for="a_mcq_instr">For multiple choice</label><textarea id="a_mcq_instr"></textarea></div>
            <div class="field"><label for="a_sa_instr">For short answer</label><textarea id="a_sa_instr"></textarea></div>
            <div class="field"><label for="a_coding_instr">For coding</label><textarea id="a_coding_instr"></textarea></div>
          </div>
        </div>
      </div></div>

    <div class="step" id="manualSection"><div class="num">3</div>
      <div class="card">
        <h3>Your questions</h3>
        <p class="small muted" id="manualHelp"></p>
        <div class="cluster" style="margin-bottom:14px;">
          <button class="btn secondary small" onclick="addManualMcq()">Add multiple choice</button>
          <button class="btn secondary small" onclick="addManualShortAnswer()">Add short answer</button>
          ${featureFlags.manual_coding
            ? `<button class="btn secondary small" onclick="addManualCoding()">Add coding</button>`
            : `<button class="btn small" type="button" disabled aria-disabled="true">Add coding</button>${UNAVAILABLE_CHIP}`}
        </div>
        ${featureFlags.manual_coding ? "" : `<p class="small muted" style="margin-top:-6px;">Writing coding questions by hand is switched off for now. In Hybrid or AI mode the AI can still write coding questions for you.</p>`}
        <div id="manualList"></div>
      </div></div>

    <p><button class="btn blue" onclick="createAssignment('${subjectId}')">Create assignment</button></p>`;

  onModeChange();
  renderManualList();
}

function currentMode() { return document.querySelector('input[name="a_mode"]:checked').value; }

function onModeChange() {
  const mode = currentMode();
  const hints = {
    manual: "You write every question yourself.",
    hybrid: "You write some; the AI fills the remaining slots.",
    ai: "The AI writes all of them from your instructions and class material.",
  };
  document.getElementById("modeHint").textContent = hints[mode];
  document.getElementById("manualSection").hidden = mode === "ai";
  document.getElementById("aiInstructions").hidden = mode === "manual";
  document.getElementById("manualHelp").textContent = mode === "hybrid"
    ? "Add the ones you want to write. The AI fills whatever is left of each count."
    : "Add enough questions to cover each count above.";

  // Manual coding is off: a Manual assignment can't contain coding questions.
  const coding = document.getElementById("a_coding");
  const lockCoding = !featureFlags.manual_coding && mode === "manual";
  if (lockCoding) coding.value = 0;
  coding.disabled = lockCoding;
  document.getElementById("codingHint").textContent = lockCoding ? "Unavailable in Manual mode for now." : "";
  updateSum();
}

function updateSum() {
  const n = id => parseInt(document.getElementById(id).value, 10) || 0;
  const parts = n("a_mcq") + n("a_sa") + n("a_coding"), total = n("a_total");
  const el = document.getElementById("sumLine");
  const ok = parts === total;
  el.className = "sum" + (ok ? "" : " bad");
  el.textContent = ok ? `${n("a_mcq")} + ${n("a_sa")} + ${n("a_coding")} = ${total} questions. Adds up.`
                      : `The three counts add up to ${parts}, but total questions is ${total}.`;
}

async function uploadPdf(subjectId) {
  const fileInput = document.getElementById("pdfFile");
  if (!fileInput.files.length) return notify("Choose a PDF first.", "error");
  const statusEl = document.getElementById("pdfStatus");
  statusEl.textContent = "Uploading and reading the file…";
  const form = new FormData();
  form.append("file", fileInput.files[0]);
  try {
    const doc = await Api.post(`/lecturer/subjects/${subjectId}/pdf`, form, { isForm: true });
    uploadedDocId = doc.id;
    statusEl.textContent = `Ready: ${doc.page_count} pages, ${doc.knowledge_items} concepts picked out.`;
  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--bad);">${escapeHtml(err.message)}</span>`;
  }
}

function addManualMcq() { manualQuestions.mcq.push({ prompt: "", options: ["", ""], correct_option_index: 0 }); renderManualList(); }
function addManualShortAnswer() { manualQuestions.short_answer.push({ prompt: "", accepted_answers: [""] }); renderManualList(); }
function addManualCoding() {
  if (!featureFlags.manual_coding) return;
  manualQuestions.coding.push({ prompt: "", language: "python", expected_behavior: "", constraints: "",
    sample_input: "", sample_output: "", hidden_test_cases: [] });
  renderManualList();
}

function renderManualList() {
  const el = document.getElementById("manualList");
  let html = "";
  manualQuestions.mcq.forEach((q, i) => {
    html += `<div class="card">
      <div class="between"><strong>Multiple choice ${i + 1}</strong>
        <button class="btn secondary small" onclick="manualQuestions.mcq.splice(${i},1); renderManualList();">Remove</button></div>
      <div class="field" style="margin-top:10px;"><label>Question</label><textarea onchange="manualQuestions.mcq[${i}].prompt=this.value">${escapeHtml(q.prompt)}</textarea></div>
      ${q.options.map((o, oi) => `<div class="field"><label>Option ${oi + 1}</label>
        <input value="${escapeHtml(o)}" onchange="manualQuestions.mcq[${i}].options[${oi}]=this.value" />
        <label class="inline-pick"><input type="radio" name="mcq_correct_${i}" ${q.correct_option_index === oi ? "checked" : ""}
          onchange="manualQuestions.mcq[${i}].correct_option_index=${oi}" /> This is the right answer</label></div>`).join("")}
      <button class="btn secondary small" onclick="manualQuestions.mcq[${i}].options.push(''); renderManualList();">Add option</button>
    </div>`;
  });
  manualQuestions.short_answer.forEach((q, i) => {
    html += `<div class="card">
      <div class="between"><strong>Short answer ${i + 1}</strong>
        <button class="btn secondary small" onclick="manualQuestions.short_answer.splice(${i},1); renderManualList();">Remove</button></div>
      <div class="field" style="margin-top:10px;"><label>Question</label><textarea onchange="manualQuestions.short_answer[${i}].prompt=this.value">${escapeHtml(q.prompt)}</textarea></div>
      <div class="field"><label>Accepted answers</label>
        <input value="${escapeHtml((q.accepted_answers || []).join(', '))}" onchange="manualQuestions.short_answer[${i}].accepted_answers=this.value.split(',').map(s=>s.trim()).filter(Boolean)" />
        <span class="hint">Separate different accepted spellings or phrasings with commas.</span></div>
    </div>`;
  });
  // Only reachable when FEATURE_MANUAL_CODING is on.
  manualQuestions.coding.forEach((q, i) => {
    const totalCases = (q.hidden_test_cases || []).length + (q.sample_input ? 1 : 0);
    html += `<div class="card">
      <div class="between"><strong>Coding ${i + 1}</strong>
        <button class="btn secondary small" onclick="manualQuestions.coding.splice(${i},1); renderManualList();">Remove</button></div>
      <div class="field" style="margin-top:10px;"><label>Problem statement</label><textarea onchange="manualQuestions.coding[${i}].prompt=this.value">${escapeHtml(q.prompt)}</textarea></div>
      <div class="field"><label>Expected behaviour (shown to students)</label><textarea onchange="manualQuestions.coding[${i}].expected_behavior=this.value">${escapeHtml(q.expected_behavior)}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Language</label>
          <select onchange="manualQuestions.coding[${i}].language=this.value">
            ${["python", "java", "javascript"].map(l => `<option value="${l}" ${q.language === l ? "selected" : ""}>${l[0].toUpperCase() + l.slice(1)}</option>`).join("")}
          </select></div>
        <div class="field"><label>Constraints <span class="muted">(optional)</span></label>
          <input value="${escapeHtml(q.constraints || "")}" onchange="manualQuestions.coding[${i}].constraints=this.value" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Sample input (shown)</label><input value="${escapeHtml(q.sample_input || "")}" onchange="manualQuestions.coding[${i}].sample_input=this.value" /></div>
        <div class="field"><label>Sample output (shown)</label><input value="${escapeHtml(q.sample_output || "")}" onchange="manualQuestions.coding[${i}].sample_output=this.value" /></div>
      </div>
      <p class="label">Hidden test cases <span class="muted">(used for marking, not shown)</span></p>
      ${(q.hidden_test_cases || []).map((tc, ti) => `<div class="field-row">
        <div class="field"><input placeholder="Input" aria-label="Test input" value="${escapeHtml(tc.input || "")}" onchange="manualQuestions.coding[${i}].hidden_test_cases[${ti}].input=this.value" /></div>
        <div class="field"><input placeholder="Expected output" aria-label="Expected output" value="${escapeHtml(tc.expected_output || "")}" onchange="manualQuestions.coding[${i}].hidden_test_cases[${ti}].expected_output=this.value" /></div>
        <div class="field"><button class="btn secondary small" onclick="manualQuestions.coding[${i}].hidden_test_cases.splice(${ti},1); renderManualList();">Remove</button></div>
      </div>`).join("")}
      <button class="btn secondary small" onclick="manualQuestions.coding[${i}].hidden_test_cases.push({input:'',expected_output:''}); renderManualList();">Add hidden test case</button>
      <p class="small" style="margin-top:8px; color:${totalCases ? "var(--ink-2)" : "var(--bad)"};">${totalCases
        ? `${totalCases} test case(s) will be used for marking.`
        : "No test cases yet. This question can't be marked automatically until you add at least one."}</p>
    </div>`;
  });
  el.innerHTML = html || `<p class="small muted">Nothing added yet.</p>`;
}

async function createAssignment(subjectId) {
  const mode = currentMode();
  const val = id => document.getElementById(id).value;
  const num = id => parseInt(val(id), 10) || 0;

  if (!val("a_title").trim()) return notify("Give the assignment a title.", "error");
  if (!val("a_start") || !val("a_deadline")) return notify("Set when it opens and when it's due.", "error");
  if (num("a_mcq") + num("a_sa") + num("a_coding") !== num("a_total"))
    return notify("The question counts don't add up to the total.", "error");

  const badCoding = manualQuestions.coding.findIndex(q => (q.hidden_test_cases || []).length === 0 && !q.sample_input);
  if (badCoding !== -1)
    return notify(`Coding question ${badCoding + 1} has no test cases. Add one so it can be marked.`, "error");

  const payload = {
    subject_id: subjectId, title: val("a_title").trim(), mode,
    total_questions: num("a_total"), mcq_count: num("a_mcq"), short_answer_count: num("a_sa"), coding_count: num("a_coding"),
    num_sets: num("a_sets") || 1, overall_difficulty: val("a_difficulty"),
    timer_seconds_default: num("a_timer"), result_buffer_seconds: num("a_buffer"),
    start_at: new Date(val("a_start")).toISOString(), deadline_at: new Date(val("a_deadline")).toISOString(),
    general_ai_instructions: val("a_gen_instr") || null, mcq_ai_instructions: val("a_mcq_instr") || null,
    short_answer_ai_instructions: val("a_sa_instr") || null, coding_ai_instructions: val("a_coding_instr") || null,
    manual_mcqs: mode === "ai" ? [] : manualQuestions.mcq,
    manual_short_answers: mode === "ai" ? [] : manualQuestions.short_answer,
    manual_coding: mode === "ai" || !featureFlags.manual_coding ? [] : manualQuestions.coding,
    source_document_id: uploadedDocId,
  };
  try {
    const created = await Api.post("/assignments", payload);
    notify(`Assignment created (${created.status}).${mode === "manual" ? "" : " AI questions are being written in the background."}`);
    Router.go(`subject/${subjectId}`);
  } catch (err) { notify(err.message, "error"); }
}

// -------------------------------------------------------------- analytics
async function renderAssignmentAnalytics({ assignmentId }, outlet) {
  setCrumb("Assignment analytics");
  outlet.innerHTML = loadingBlock();
  try {
    const data = await Api.get(`/analytics/assignments/${assignmentId}/overview`);
    const s = data.summary;
    outlet.innerHTML = `
      <div class="grid cols-3">
        <div class="card stat"><div class="value">${s.attempts}</div><div class="label">Attempts</div></div>
        <div class="card stat"><div class="value">${s.avg_percentage ? Number(s.avg_percentage).toFixed(1) : 0}%</div><div class="label">Average</div></div>
        <div class="card stat"><div class="value">${s.max_percentage ?? 0}%</div><div class="label">Top score</div></div>
      </div>
      <div class="card">
        <div class="between" style="margin-bottom:12px;"><h3 style="margin:0;">Question by question</h3>
          <button class="btn secondary small" onclick="downloadArchive('${assignmentId}')">Download Excel</button></div>
        ${tableHtml([{ label: "Type" }, { label: "Question" }, { label: "Correct" }, { label: "Attempts" }],
          data.per_question.map(q => [escapeHtml(q.type), escapeHtml((q.prompt || "").slice(0, 80)), q.correct_count, q.attempt_count]),
          `<p class="muted">No answers yet.</p>`)}
      </div>
      <div class="card"><h3>Proctoring flags</h3>
        ${data.violations.length ? data.violations.map(v => `<span class="badge warn">${escapeHtml(v.type)}: ${v.count}</span> `).join("")
          : `<p class="muted" style="margin:0;">Nothing flagged.</p>`}
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function downloadArchive(assignmentId) {
  try {
    const res = await fetch(`${API_BASE}/archive/assignments/${assignmentId}.xlsx`, { headers: { Authorization: `Bearer ${Auth.token()}` } });
    if (!res.ok) {
      if (res.status === 401) { Auth.logout(); return; }
      throw new Error(`Download failed (status ${res.status}).`);
    }
    const blob = await res.blob();
    const match = (res.headers.get("Content-Disposition") || "").match(/filename="?([^"]+)"?/);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = match ? match[1] : `assignment_${assignmentId}_results.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (err) { notify(err.message || "Download failed.", "error"); }
}

// ------------------------------------------------------------ question bank
async function renderQuestionBank({ subjectId }, outlet) {
  setCrumb("Question bank", "Your own questions, kept for reuse. Nobody else sees them.", { href: `#subject/${subjectId}`, label: "Subject" });
  outlet.innerHTML = loadingBlock();
  try {
    const questions = await Api.get(`/lecturer/subjects/${subjectId}/question-bank`);
    outlet.innerHTML = tableHtml(
      [{ label: "Type" }, { label: "Question" }, { label: "Difficulty" }, { label: "Status" }, { label: "Source" }, { label: "" }],
      questions.map(q => [escapeHtml(q.type), escapeHtml((q.prompt || "").slice(0, 90)), escapeHtml(q.difficulty),
        `<span class="badge ${q.status === "valid" ? "ok" : "neutral"}">${escapeHtml(q.status)}</span>`, escapeHtml(q.source),
        { html: `<button class="btn secondary small" onclick="deleteBankQuestion('${subjectId}','${q.id}')">Delete</button>`, cls: "actions" }]),
      `<div class="empty-state"><h3>Empty for now</h3><p>Questions from your assignments will collect here.</p></div>`);
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function deleteBankQuestion(subjectId, questionId) {
  if (!confirm("Remove this question from your bank?")) return;
  try {
    await Api.del(`/lecturer/question-bank/${questionId}`);
    renderQuestionBank({ subjectId }, document.getElementById("outlet"));
  } catch (err) { notify(err.message, "error"); }
}

// ----------------------------------------------------------------- profile
async function renderProfile(_, outlet) {
  setCrumb("Profile");
  outlet.innerHTML = loadingBlock();
  try {
    const me = await Api.get("/lecturer/me");
    outlet.innerHTML = `<div class="card" style="max-width:440px;">
      <div class="field"><label for="p_id">Lecturer ID</label><input id="p_id" value="${escapeHtml(me.lecturer_id)}" disabled /></div>
      <div class="field"><label for="p_name">Full name</label><input id="p_name" value="${escapeHtml(me.full_name)}" /></div>
      <div class="field"><label for="p_email">Email</label><input id="p_email" type="email" value="${escapeHtml(me.email || "")}" /></div>
      <button class="btn" onclick="saveProfile()">Save</button></div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}
async function saveProfile() {
  try {
    await Api.put("/lecturer/me", { full_name: document.getElementById("p_name").value, email: document.getElementById("p_email").value });
    notify("Profile saved.");
  } catch (err) { notify(err.message, "error"); }
}

// ------------------------------------------------------------------ router
Router.register("semesters", renderSemesters);
Router.register("create-subject", renderCreateSubject);
Router.register("semester/:semId/sections", renderSections);
Router.register("section/:secId/subjects", renderSubjects);
Router.register("subject/:subjectId", renderSubjectOverview);
Router.register("subject/:subjectId/new-assignment", renderNewAssignment);
Router.register("subject/:subjectId/question-bank", renderQuestionBank);
Router.register("assignment/:assignmentId/analytics", renderAssignmentAnalytics);
Router.register("profile", renderProfile);
Router.init(document.getElementById("outlet"), { notFound: () => Router.go("semesters") });
if (!location.hash) Router.go("semesters");