// -------------------------------------------------------------------------
// Lecturer app. Route map follows the spec's dashboard hierarchy:
//   #semesters
//   #semester/:semId/sections
//   #section/:secId/subjects?semId=..
//   #subject/:subjectId                       -> overview (PDF, assignments, students)
//   #subject/:subjectId/new-assignment
//   #assignment/:assignmentId/analytics
//   #subject/:subjectId/question-bank
//   #profile
// -------------------------------------------------------------------------

if (!Auth.isLoggedIn() || Auth.role() !== "lecturer") {
  window.location.href = "../index.html";
}
document.getElementById("userPill").textContent = Auth.name();

function setCrumb(t) { document.getElementById("crumb").innerHTML = `<h2>${t}</h2>`; }
function loadingBlock() { return `<div class="loading"><div class="spinner"></div>Loading…</div>`; }
function errorBlock(err) { return `<div class="error-banner">${err.message || "Something went wrong."}</div>`; }
function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str || ""; return d.innerHTML; }

// --------------------------------------------------------------- semesters
async function renderSemesters(_, outlet) {
  setCrumb("Your Semesters");
  outlet.innerHTML = loadingBlock();
  try {
    const semesters = await Api.get("/lecturer/semesters");
    const createButton = `<button class="btn" onclick="Router.go('create-subject')" style="margin-bottom:18px;">+ Create a New Subject</button>`;
    if (!semesters.length) {
      outlet.innerHTML = createButton + `<div class="empty-state"><h3>No subjects yet</h3>
        <p>Create your first subject to get started — pick a semester and section, name it, and you're set.</p></div>`;
      return;
    }
    outlet.innerHTML = createButton + `<div class="grid grid-3">` + semesters.map(s => `
      <div class="card" style="cursor:pointer" onclick="Router.go('semester/${s.id}/sections')">
        <h3>${escapeHtml(s.name)}</h3>
      </div>`).join("") + `</div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------- create a subject
// Browses ALL semesters/sections (not just ones the lecturer already
// teaches in) so they can set up their first subject, or add another one.
let createSubjectState = { semesterId: null, sectionId: null };

async function renderCreateSubject(_, outlet) {
  setCrumb("Create a Subject");
  createSubjectState = { semesterId: null, sectionId: null };
  outlet.innerHTML = loadingBlock();
  try {
    const semesters = await Api.get("/lecturer/browse/semesters");
    if (!semesters.length) {
      outlet.innerHTML = `<div class="empty-state"><h3>No semesters yet</h3>
        <p>Ask your admin to set up a semester and section first.</p></div>`;
      return;
    }
    outlet.innerHTML = `
      <div class="card">
        <h3>1. Choose a semester</h3>
        <div class="field">
          <select id="cs_semester" onchange="onCreateSubjectSemesterChange()">
            <option value="">Select a semester…</option>
            ${semesters.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="card" id="cs_sectionCard" style="display:none;">
        <h3>2. Choose a section</h3>
        <div class="field"><select id="cs_section" onchange="onCreateSubjectSectionChange()"></select></div>
      </div>
      <div class="card" id="cs_detailsCard" style="display:none;">
        <h3>3. Name the subject</h3>
        <div class="field"><label>Subject name</label><input id="cs_name" /></div>
        <div class="field"><label>Description (optional)</label><input id="cs_desc" /></div>
        <button class="btn" onclick="submitCreateSubject()">Create Subject</button>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function onCreateSubjectSemesterChange() {
  const semesterId = document.getElementById("cs_semester").value;
  createSubjectState.semesterId = semesterId || null;
  const sectionCard = document.getElementById("cs_sectionCard");
  const detailsCard = document.getElementById("cs_detailsCard");
  detailsCard.style.display = "none";
  if (!semesterId) { sectionCard.style.display = "none"; return; }

  const sections = await Api.get(`/lecturer/browse/semesters/${semesterId}/sections`);
  const sectionSelect = document.getElementById("cs_section");
  sectionSelect.innerHTML = `<option value="">Select a section…</option>` +
    sections.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  sectionCard.style.display = "block";
}

function onCreateSubjectSectionChange() {
  const sectionId = document.getElementById("cs_section").value;
  createSubjectState.sectionId = sectionId || null;
  document.getElementById("cs_detailsCard").style.display = sectionId ? "block" : "none";
}

async function submitCreateSubject() {
  const name = document.getElementById("cs_name").value.trim();
  if (!name) return alert("Subject name is required.");
  if (!createSubjectState.sectionId) return alert("Choose a section first.");
  try {
    const subject = await Api.post("/lecturer/subjects", {
      section_id: createSubjectState.sectionId, name,
      description: document.getElementById("cs_desc").value.trim() || null,
    });
    Router.go(`subject/${subject.id}`);
  } catch (err) { alert(err.message); }
}

async function renderSections({ semId }, outlet) {
  setCrumb("Sections");
  outlet.innerHTML = loadingBlock();
  try {
    const sections = await Api.get(`/lecturer/semesters/${semId}/sections`);
    outlet.innerHTML = `<div class="grid grid-3">` + sections.map(s => `
      <div class="card" style="cursor:pointer" onclick="Router.go('section/${s.id}/subjects')">
        <h3>Section ${escapeHtml(s.name)}</h3>
      </div>`).join("") + `</div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function renderSubjects({ secId }, outlet) {
  setCrumb("Subjects");
  outlet.innerHTML = loadingBlock();
  try {
    const subjects = await Api.get(`/lecturer/sections/${secId}/subjects`);
    const list = subjects.map(s => `
      <div class="card" style="cursor:pointer" onclick="Router.go('subject/${s.id}')">
        <h3>${escapeHtml(s.name)}</h3>
        <p style="color:var(--ink-soft); font-size:.85rem; margin:0;">${escapeHtml(s.description || "")}</p>
      </div>`).join("");
    outlet.innerHTML = `<div class="grid grid-3">${list}</div>
      <div class="card" style="margin-top:18px;">
        <h3>Add a subject</h3>
        <div class="field"><label>Subject name</label><input id="newSubjectName" /></div>
        <div class="field"><label>Description (optional)</label><input id="newSubjectDesc" /></div>
        <button class="btn" onclick="createSubject('${secId}')">Add Subject</button>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function createSubject(secId) {
  const name = document.getElementById("newSubjectName").value.trim();
  if (!name) return alert("Subject name is required.");
  try {
    await Api.post("/lecturer/subjects", {
      section_id: secId, name, description: document.getElementById("newSubjectDesc").value.trim() || null,
    });
    Router.go(`section/${secId}/subjects`);
    renderSubjects({ secId }, document.getElementById("outlet"));
  } catch (err) { alert(err.message); }
}

// ----------------------------------------------------------- subject page
async function renderSubjectOverview({ subjectId }, outlet) {
  setCrumb("Subject");
  outlet.innerHTML = loadingBlock();
  try {
    const [assignments, students] = await Promise.all([
      Api.get(`/assignments/subject/${subjectId}`),
      Api.get(`/lecturer/subjects/${subjectId}/students`),
    ]);
    outlet.innerHTML = `
      <div style="display:flex; gap:10px; margin-bottom:18px;">
        <button class="btn" onclick="Router.go('subject/${subjectId}/new-assignment')">+ New Assignment</button>
        <button class="btn secondary" onclick="Router.go('subject/${subjectId}/question-bank')">Question Bank</button>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <h3>Assignments (${assignments.length})</h3>
          ${assignments.length ? assignments.map(a => `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--paper-dim);">
              <span>${escapeHtml(a.title)} <span class="badge neutral">${a.status}</span></span>
              <a href="#" onclick="Router.go('assignment/${a.id}/analytics'); return false;">Analytics →</a>
            </div>`).join("") : `<p style="color:var(--ink-soft);">No assignments yet.</p>`}
        </div>
        <div class="card">
          <h3>Students (${students.length})</h3>
          <p style="font-size:.82rem; color:var(--ink-soft);">Auto-derived from semester + section — no manual add needed.</p>
          <div style="max-height:220px; overflow:auto;">
            ${students.map(s => `<div style="padding:6px 0; border-bottom:1px solid var(--paper-dim); font-size:.88rem;">
              ${escapeHtml(s.full_name)} <span style="color:var(--ink-soft);">(${escapeHtml(s.register_number)})</span></div>`).join("")}
          </div>
        </div>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------ assignment builder
let manualQuestions = { mcq: [], short_answer: [], coding: [] };
let uploadedDocId = null;

async function renderNewAssignment({ subjectId }, outlet) {
  setCrumb("New Assignment");
  manualQuestions = { mcq: [], short_answer: [], coding: [] };
  uploadedDocId = null;

  outlet.innerHTML = `
    <div class="card">
      <h3>1. Upload class material (PDF)</h3>
      <input type="file" id="pdfFile" accept="application/pdf" />
      <button class="btn secondary" style="margin-left:10px;" onclick="uploadPdf('${subjectId}')">Upload</button>
      <div id="pdfStatus" style="margin-top:8px; font-size:.85rem; color:var(--ink-soft);"></div>
    </div>

    <div class="card">
      <h3>2. Configuration</h3>
      <div class="field"><label>Title</label><input id="a_title" /></div>
      <div class="field-row">
        <div class="field"><label>Mode</label>
          <select id="a_mode" onchange="toggleManualSections()">
            <option value="manual">Manual</option><option value="ai">AI</option><option value="hybrid" selected>Hybrid</option>
          </select>
        </div>
        <div class="field"><label>Overall difficulty</label>
          <select id="a_difficulty"><option>easy</option><option selected>medium</option><option>hard</option></select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Total questions</label><input id="a_total" type="number" value="10" /></div>
        <div class="field"><label>MCQ count</label><input id="a_mcq" type="number" value="4" /></div>
        <div class="field"><label>Short answer count</label><input id="a_sa" type="number" value="3" /></div>
        <div class="field"><label>Coding count</label><input id="a_coding" type="number" value="3" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Number of sets</label><input id="a_sets" type="number" value="1" /></div>
        <div class="field"><label>Timer per MCQ/SA question (sec)</label><input id="a_timer" type="number" value="45" /></div>
        <div class="field"><label>Result buffer (sec)</label><input id="a_buffer" type="number" value="0" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Start date/time</label><input id="a_start" type="datetime-local" /></div>
        <div class="field"><label>Deadline</label><input id="a_deadline" type="datetime-local" /></div>
      </div>
      <div class="field"><label>General AI instructions (optional)</label><textarea id="a_gen_instr"></textarea></div>
      <div class="field-row">
        <div class="field"><label>MCQ AI instructions</label><textarea id="a_mcq_instr"></textarea></div>
        <div class="field"><label>Short answer AI instructions</label><textarea id="a_sa_instr"></textarea></div>
        <div class="field"><label>Coding AI instructions</label><textarea id="a_coding_instr"></textarea></div>
      </div>
    </div>

    <div class="card" id="manualSection">
      <h3>3. Manual questions</h3>
      <p style="font-size:.82rem; color:var(--ink-soft);">
        In Hybrid mode, AI fills only the remaining slots per type. In Manual mode, supply all required questions.
      </p>
      <div style="display:flex; gap:10px; margin-bottom:14px;">
        <button class="btn secondary" onclick="addManualMcq()">+ MCQ</button>
        <button class="btn secondary" onclick="addManualShortAnswer()">+ Short Answer</button>
        <button class="btn secondary" onclick="addManualCoding()">+ Coding</button>
      </div>
      <div id="manualList"></div>
    </div>

    <button class="btn" onclick="createAssignment('${subjectId}')">Create Assignment</button>
  `;
}

function toggleManualSections() {
  const mode = document.getElementById("a_mode").value;
  document.getElementById("manualSection").style.display = mode === "ai" ? "none" : "block";
}

async function uploadPdf(subjectId) {
  const fileInput = document.getElementById("pdfFile");
  if (!fileInput.files.length) return alert("Choose a PDF first.");
  const statusEl = document.getElementById("pdfStatus");
  statusEl.textContent = "Uploading and processing…";
  const form = new FormData();
  form.append("file", fileInput.files[0]);
  try {
    const doc = await Api.post(`/lecturer/subjects/${subjectId}/pdf`, form, { isForm: true });
    uploadedDocId = doc.id;
    statusEl.textContent = `Ready — ${doc.page_count} pages, ${doc.knowledge_items} concepts extracted.`;
  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--bad);">${err.message}</span>`;
  }
}

function addManualMcq() {
  manualQuestions.mcq.push({ prompt: "", options: ["", ""], correct_option_index: 0 });
  renderManualList();
}
function addManualShortAnswer() {
  manualQuestions.short_answer.push({ prompt: "", accepted_answers: [""] });
  renderManualList();
}
function addManualCoding() {
  manualQuestions.coding.push({
    prompt: "", language: "python", expected_behavior: "", constraints: "",
    sample_input: "", sample_output: "", hidden_test_cases: [],
  });
  renderManualList();
}

function renderManualList() {
  const el = document.getElementById("manualList");
  let html = "";
  manualQuestions.mcq.forEach((q, i) => {
    html += `<div class="card">
      <strong>MCQ ${i + 1}</strong>
      <div class="field"><textarea onchange="manualQuestions.mcq[${i}].prompt=this.value">${escapeHtml(q.prompt)}</textarea></div>
      ${q.options.map((o, oi) => `<div class="field-row">
        <input value="${escapeHtml(o)}" placeholder="Option ${oi + 1}"
          onchange="manualQuestions.mcq[${i}].options[${oi}]=this.value" />
        <label style="display:flex;align-items:center;gap:4px;">
          <input type="radio" name="mcq_correct_${i}" ${q.correct_option_index === oi ? "checked" : ""}
            onchange="manualQuestions.mcq[${i}].correct_option_index=${oi}" /> Correct
        </label></div>`).join("")}
      <button class="btn secondary" onclick="manualQuestions.mcq[${i}].options.push(''); renderManualList();">+ Option</button>
    </div>`;
  });
  manualQuestions.short_answer.forEach((q, i) => {
    html += `<div class="card">
      <strong>Short Answer ${i + 1}</strong>
      <div class="field"><textarea onchange="manualQuestions.short_answer[${i}].prompt=this.value">${escapeHtml(q.prompt)}</textarea></div>
      <div class="field"><label>Accepted answers (comma-separated)</label>
        <input onchange="manualQuestions.short_answer[${i}].accepted_answers=this.value.split(',').map(s=>s.trim())" /></div>
    </div>`;
  });
  manualQuestions.coding.forEach((q, i) => {
    const totalCases = (q.hidden_test_cases || []).length + (q.sample_input ? 1 : 0);
    html += `<div class="card">
      <strong>Coding ${i + 1}</strong>
      <div class="field"><textarea placeholder="Problem statement"
        onchange="manualQuestions.coding[${i}].prompt=this.value">${escapeHtml(q.prompt)}</textarea></div>
      <div class="field"><textarea placeholder="Expected behavior / constraints (shown to student)"
        onchange="manualQuestions.coding[${i}].expected_behavior=this.value">${escapeHtml(q.expected_behavior)}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Language</label>
          <select onchange="manualQuestions.coding[${i}].language=this.value">
            <option value="python" ${q.language === "python" ? "selected" : ""}>Python</option>
            <option value="java" ${q.language === "java" ? "selected" : ""}>Java</option>
            <option value="javascript" ${q.language === "javascript" ? "selected" : ""}>JavaScript</option>
          </select>
        </div>
        <div class="field"><label>Constraints (optional)</label>
          <input value="${escapeHtml(q.constraints || "")}"
            onchange="manualQuestions.coding[${i}].constraints=this.value" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Sample input (shown to student)</label>
          <input value="${escapeHtml(q.sample_input || "")}"
            onchange="manualQuestions.coding[${i}].sample_input=this.value" /></div>
        <div class="field"><label>Sample expected output</label>
          <input value="${escapeHtml(q.sample_output || "")}"
            onchange="manualQuestions.coding[${i}].sample_output=this.value" /></div>
      </div>
      <label style="font-size:.85rem;">Hidden test cases (used for grading, not shown to student)</label>
      ${(q.hidden_test_cases || []).map((tc, ti) => `<div class="field-row">
        <input placeholder="Input" value="${escapeHtml(tc.input || "")}"
          onchange="manualQuestions.coding[${i}].hidden_test_cases[${ti}].input=this.value" />
        <input placeholder="Expected output" value="${escapeHtml(tc.expected_output || "")}"
          onchange="manualQuestions.coding[${i}].hidden_test_cases[${ti}].expected_output=this.value" />
        <button class="btn secondary" onclick="manualQuestions.coding[${i}].hidden_test_cases.splice(${ti},1); renderManualList();">Remove</button>
      </div>`).join("")}
      <button class="btn secondary" onclick="manualQuestions.coding[${i}].hidden_test_cases.push({input:'',expected_output:''}); renderManualList();">+ Hidden Test Case</button>
      ${totalCases === 0
        ? `<p style="color:var(--bad); font-size:.8rem; margin-top:6px;">⚠ No sample or hidden test cases yet — this question cannot be auto-graded until you add at least one.</p>`
        : `<p style="color:var(--ink-soft); font-size:.8rem; margin-top:6px;">${totalCases} test case(s) will be used for grading.</p>`}
    </div>`;
  });
  el.innerHTML = html || `<p style="color:var(--ink-soft); font-size:.85rem;">No manual questions added yet.</p>`;
}

async function createAssignment(subjectId) {
  const mode = document.getElementById("a_mode").value;

  const badCoding = manualQuestions.coding.findIndex(
    q => (q.hidden_test_cases || []).length === 0 && !q.sample_input
  );
  if (badCoding !== -1) {
    return alert(`Coding question ${badCoding + 1} has no sample or hidden test cases. ` +
      `Add at least one test case so it can be auto-graded before creating the assignment.`);
  }

  const payload = {
    subject_id: subjectId,
    title: document.getElementById("a_title").value.trim(),
    mode,
    total_questions: parseInt(document.getElementById("a_total").value, 10),
    mcq_count: parseInt(document.getElementById("a_mcq").value, 10),
    short_answer_count: parseInt(document.getElementById("a_sa").value, 10),
    coding_count: parseInt(document.getElementById("a_coding").value, 10),
    num_sets: parseInt(document.getElementById("a_sets").value, 10),
    overall_difficulty: document.getElementById("a_difficulty").value,
    timer_seconds_default: parseInt(document.getElementById("a_timer").value, 10),
    result_buffer_seconds: parseInt(document.getElementById("a_buffer").value, 10),
    start_at: new Date(document.getElementById("a_start").value).toISOString(),
    deadline_at: new Date(document.getElementById("a_deadline").value).toISOString(),
    general_ai_instructions: document.getElementById("a_gen_instr").value || null,
    mcq_ai_instructions: document.getElementById("a_mcq_instr").value || null,
    short_answer_ai_instructions: document.getElementById("a_sa_instr").value || null,
    coding_ai_instructions: document.getElementById("a_coding_instr").value || null,
    manual_mcqs: manualQuestions.mcq,
    manual_short_answers: manualQuestions.short_answer,
    manual_coding: manualQuestions.coding,
    source_document_id: uploadedDocId,
  };
  try {
    const created = await Api.post("/assignments", payload);
    alert(`Assignment created (status: ${created.status}). AI generation, if any, runs in the background.`);
    Router.go(`subject/${subjectId}`);
  } catch (err) { alert(err.message); }
}

// -------------------------------------------------------------- analytics
async function renderAssignmentAnalytics({ assignmentId }, outlet) {
  setCrumb("Assignment Analytics");
  outlet.innerHTML = loadingBlock();
  try {
    const data = await Api.get(`/analytics/assignments/${assignmentId}/overview`);
    const s = data.summary;
    outlet.innerHTML = `
      <div class="grid grid-3">
        <div class="card stat"><div class="value">${s.attempts}</div><div class="label">Attempts</div></div>
        <div class="card stat"><div class="value">${s.avg_percentage ? Number(s.avg_percentage).toFixed(1) : 0}%</div><div class="label">Average</div></div>
        <div class="card stat"><div class="value">${s.max_percentage ?? 0}%</div><div class="label">Top score</div></div>
      </div>
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3>Per-question breakdown</h3>
          <button class="btn secondary" onclick="downloadArchive('${assignmentId}')">Download Excel Archive</button>
        </div>
        <table><thead><tr><th>Type</th><th>Prompt</th><th>Correct</th><th>Attempts</th></tr></thead>
        <tbody>${data.per_question.map(q => `<tr><td>${q.type}</td><td>${escapeHtml((q.prompt||'').slice(0,60))}</td>
          <td>${q.correct_count}</td><td>${q.attempt_count}</td></tr>`).join("")}</tbody></table>
      </div>
      <div class="card">
        <h3>Proctoring violations</h3>
        ${data.violations.length ? data.violations.map(v => `<span class="badge warn">${v.type}: ${v.count}</span> `).join("")
          : `<p style="color:var(--ink-soft);">None reported.</p>`}
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function downloadArchive(assignmentId) {
  try {
    const res = await fetch(`${API_BASE}/archive/assignments/${assignmentId}.xlsx`, {
      headers: { Authorization: `Bearer ${Auth.token()}` },
    });
    if (!res.ok) {
      if (res.status === 401) { Auth.logout(); return; }
      throw new Error(`Download failed (status ${res.status}).`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `assignment_${assignmentId}_results.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.message || "Download failed.");
  }
}

// -------------------------------------------------------------- question bank
async function renderQuestionBank({ subjectId }, outlet) {
  setCrumb("Question Bank");
  outlet.innerHTML = loadingBlock();
  try {
    const questions = await Api.get(`/lecturer/subjects/${subjectId}/question-bank`);
    outlet.innerHTML = `<table><thead><tr><th>Type</th><th>Prompt</th><th>Difficulty</th><th>Status</th><th>Source</th><th></th></tr></thead>
      <tbody>${questions.map(q => `<tr>
        <td>${q.type}</td><td>${escapeHtml((q.prompt||'').slice(0,70))}</td><td>${q.difficulty}</td>
        <td><span class="badge ${q.status === 'valid' ? 'ok' : 'neutral'}">${q.status}</span></td><td>${q.source}</td>
        <td><button class="btn secondary" onclick="deleteBankQuestion('${subjectId}','${q.id}')">Delete</button></td>
      </tr>`).join("")}</tbody></table>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function deleteBankQuestion(subjectId, questionId) {
  if (!confirm("Remove this question from your bank?")) return;
  await Api.del(`/lecturer/question-bank/${questionId}`);
  renderQuestionBank({ subjectId }, document.getElementById("outlet"));
}

// ----------------------------------------------------------------- profile
async function renderProfile(_, outlet) {
  setCrumb("My Profile");
  const me = await Api.get("/lecturer/me");
  outlet.innerHTML = `<div class="card" style="max-width:400px;">
    <div class="field"><label>Lecturer ID (fixed)</label><input value="${escapeHtml(me.lecturer_id)}" disabled /></div>
    <div class="field"><label>Full name</label><input id="p_name" value="${escapeHtml(me.full_name)}" /></div>
    <div class="field"><label>Email</label><input id="p_email" value="${escapeHtml(me.email || "")}" /></div>
    <button class="btn" onclick="saveProfile()">Save</button>
  </div>`;
}
async function saveProfile() {
  await Api.put("/lecturer/me", {
    full_name: document.getElementById("p_name").value, email: document.getElementById("p_email").value,
  });
  alert("Profile updated.");
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