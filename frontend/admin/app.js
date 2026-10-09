// Admin app. Helpers (escapeHtml, setCrumb, loadingBlock, errorBlock, notify,
// tableHtml) come from shared/js/ui.js.
if (!Auth.isLoggedIn() || Auth.role() !== "admin") {
  window.location.href = "login.html";
}

// --------------------------------------------------------------- overview
async function renderOverview(_, outlet) {
  setCrumb("Overview", "A snapshot of the whole system.");
  outlet.innerHTML = loadingBlock();
  try {
    const s = await Api.get("/admin/analytics/overview");
    const stat = (v, l) => `<div class="card stat"><div class="value">${escapeHtml(v)}</div><div class="label">${l}</div></div>`;
    outlet.innerHTML = `<div class="grid cols-3">
      ${stat(s.active_students, "Active students")}${stat(s.active_lecturers, "Active lecturers")}${stat(s.total_assignments, "Assignments")}
      ${stat(s.ai_generated_questions, "AI-written questions")}${stat(s.ai_calls_total, "AI calls")}${stat(s.ai_failures, "AI failures")}
    </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------- semesters/sections
async function renderSemesters(_, outlet) {
  setCrumb("Semesters and sections");
  outlet.innerHTML = loadingBlock();
  try {
    const semesters = await Api.get("/admin/semesters");
    const rows = await Promise.all(semesters.map(async s => ({ s, sections: await Api.get(`/admin/sections?semester_id=${s.id}`) })));
    outlet.innerHTML = rows.map(({ s, sections }) => `
      <div class="card">
        <h3>${escapeHtml(s.name)}</h3>
        <div class="cluster" style="margin-bottom:12px;">
          ${sections.map(sec => `<span class="badge neutral">${escapeHtml(sec.name)}</span>`).join("") || `<span class="muted small">No sections yet</span>`}
        </div>
        <div class="field-row" style="align-items:end;">
          <div class="field" style="margin-bottom:0;"><label for="sec_${s.id}">New section name</label><input id="sec_${s.id}" placeholder="e.g. A" /></div>
          <div class="field" style="margin-bottom:0;"><button class="btn secondary" onclick="addSection('${s.id}')">Add section</button></div>
        </div>
      </div>`).join("") + `
      <div class="card">
        <h3>Add a semester</h3>
        <div class="field-row" style="align-items:end;">
          <div class="field" style="margin-bottom:0;"><label for="newSemName">Semester name</label><input id="newSemName" placeholder="e.g. Semester 5, 2026" /></div>
          <div class="field" style="margin-bottom:0;"><button class="btn" onclick="addSemester()">Add semester</button></div>
        </div>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}
async function addSemester() {
  const name = document.getElementById("newSemName").value.trim();
  if (!name) return;
  try { await Api.post("/admin/semesters", { name }); renderSemesters({}, document.getElementById("outlet")); }
  catch (err) { notify(err.message, "error"); }
}
async function addSection(semesterId) {
  const name = document.getElementById(`sec_${semesterId}`).value.trim();
  if (!name) return;
  try { await Api.post("/admin/sections", { semester_id: semesterId, name }); renderSemesters({}, document.getElementById("outlet")); }
  catch (err) { notify(err.message, "error"); }
}

// -------------------------------------------------------------- lecturers
const activeBadge = on => `<span class="badge ${on ? "ok" : "err"}">${on ? "Active" : "Inactive"}</span>`;

async function renderLecturers(_, outlet) {
  setCrumb("Lecturers");
  outlet.innerHTML = loadingBlock();
  try {
    const lecturers = await Api.get("/admin/lecturers");
    outlet.innerHTML = tableHtml(
      [{ label: "ID" }, { label: "Name" }, { label: "Email" }, { label: "Status" }, { label: "" }],
      lecturers.map(l => [escapeHtml(l.lecturer_id), escapeHtml(l.full_name), escapeHtml(l.email || "—"), activeBadge(l.is_active),
        { cls: "actions", html: `<button class="btn secondary small" onclick="resetPassword('${l.id}','lecturer')">Reset password</button>
          <button class="btn danger small" onclick="deactivateLecturer('${l.id}')">Deactivate</button>` }]),
      `<div class="empty-state"><h3>No lecturers yet</h3></div>`) + `
      <div class="card" style="margin-top:var(--gap); max-width:480px;">
        <h3>Add a lecturer</h3>
        <div class="field"><label for="l_id">Lecturer ID</label><input id="l_id" autocapitalize="off" /></div>
        <div class="field"><label for="l_name">Full name</label><input id="l_name" /></div>
        <div class="field"><label for="l_email">Email <span class="muted">(optional)</span></label><input id="l_email" type="email" /></div>
        <div class="field"><label for="l_pass">Temporary password</label><input id="l_pass" type="text" autocomplete="off" /></div>
        <button class="btn" onclick="createLecturer()">Create lecturer</button>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}
async function createLecturer() {
  try {
    await Api.post("/admin/lecturers", {
      lecturer_id: document.getElementById("l_id").value.trim(), full_name: document.getElementById("l_name").value.trim(),
      email: document.getElementById("l_email").value.trim() || null, password: document.getElementById("l_pass").value,
    });
    notify("Lecturer created.");
    renderLecturers({}, document.getElementById("outlet"));
  } catch (err) { notify(err.message, "error"); }
}
async function deactivateLecturer(id) {
  if (!confirm("Deactivate this lecturer?")) return;
  try { await Api.del(`/admin/lecturers/${id}`); renderLecturers({}, document.getElementById("outlet")); }
  catch (err) { notify(err.message, "error"); }
}

// --------------------------------------------------------------- students
async function renderStudents(_, outlet) {
  setCrumb("Students");
  outlet.innerHTML = loadingBlock();
  try {
    const [students, semesters] = await Promise.all([Api.get("/admin/students"), Api.get("/admin/semesters")]);
    outlet.innerHTML = tableHtml(
      [{ label: "Register no." }, { label: "Name" }, { label: "Status" }, { label: "" }],
      students.map(s => [escapeHtml(s.register_number), escapeHtml(s.full_name), activeBadge(s.is_active),
        { cls: "actions", html: `<button class="btn secondary small" onclick="resetPassword('${s.id}','student')">Reset password</button>
          <button class="btn danger small" onclick="deactivateStudent('${s.id}')">Deactivate</button>` }]),
      `<div class="empty-state"><h3>No students yet</h3></div>`) + `
      <div class="grid cols-2" style="margin-top:var(--gap);">
        <div class="card">
          <h3>Add a student</h3>
          <div class="field"><label for="s_reg">Register number</label><input id="s_reg" autocapitalize="off" /></div>
          <div class="field"><label for="s_name">Full name</label><input id="s_name" /></div>
          <div class="field"><label for="s_sem">Semester</label>
            <select id="s_sem" onchange="loadSectionsFor('s_sem','s_sec')">${semesters.map(sem => `<option value="${sem.id}">${escapeHtml(sem.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="s_sec">Section</label><select id="s_sec"></select></div>
          <div class="field"><label for="s_pass">Temporary password</label><input id="s_pass" autocomplete="off" /></div>
          <button class="btn" onclick="createStudent()">Create student</button>
        </div>
        <div class="card">
          <h3>Bulk upload (CSV)</h3>
          <p class="small muted">Columns: register_number, full_name, password, semester_id, section_id</p>
          <div class="field"><label for="bulkCsv" class="sr-only">CSV file</label><input type="file" id="bulkCsv" accept=".csv" /></div>
          <button class="btn secondary" onclick="bulkUploadStudents()">Upload</button>
          <div id="bulkStatus" class="small" style="margin-top:8px;" aria-live="polite"></div>
        </div>
      </div>`;
    if (semesters.length) loadSectionsFor("s_sem", "s_sec");
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}
async function loadSectionsFor(semSelectId, secSelectId) {
  const semId = document.getElementById(semSelectId).value;
  const sections = await Api.get(`/admin/sections?semester_id=${semId}`);
  document.getElementById(secSelectId).innerHTML = sections.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}
async function createStudent() {
  try {
    await Api.post("/admin/students", {
      register_number: document.getElementById("s_reg").value.trim(), full_name: document.getElementById("s_name").value.trim(),
      password: document.getElementById("s_pass").value, semester_id: document.getElementById("s_sem").value, section_id: document.getElementById("s_sec").value,
    });
    notify("Student created.");
    renderStudents({}, document.getElementById("outlet"));
  } catch (err) { notify(err.message, "error"); }
}
async function deactivateStudent(id) {
  if (!confirm("Deactivate this student?")) return;
  try { await Api.del(`/admin/students/${id}`); renderStudents({}, document.getElementById("outlet")); }
  catch (err) { notify(err.message, "error"); }
}

function parseCsv(text) {
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(",").map(h => h.trim());
  return lines.filter(Boolean).map(line => {
    const cells = line.split(",").map(c => c.trim());
    return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
  });
}
async function bulkUploadStudents() {
  const fileInput = document.getElementById("bulkCsv");
  const statusEl = document.getElementById("bulkStatus");
  if (!fileInput.files.length) return notify("Choose a CSV file first.", "error");
  const rows = parseCsv(await fileInput.files[0].text());
  try {
    const created = await Api.post("/admin/students/bulk", { students: rows });
    notify(`Created ${created.length} of ${rows.length} students.`);
    renderStudents({}, document.getElementById("outlet"));
  } catch (err) { statusEl.innerHTML = `<span class="badge err">${escapeHtml(err.message)}</span>`; }
}

async function resetPassword(userId, role) {
  const newPassword = prompt(`New password for this ${role}:`);
  if (!newPassword) return;
  try { await Api.post("/auth/reset-password", { user_id: userId, role, new_password: newPassword }); notify("Password reset."); }
  catch (err) { notify(err.message, "error"); }
}

// --------------------------------------------------------------- settings
async function renderSettings(_, outlet) {
  setCrumb("Settings");
  outlet.innerHTML = loadingBlock();
  try {
    const settings = await Api.get("/admin/settings");
    outlet.innerHTML = `<div class="card" style="max-width:520px;">
      ${Object.entries(settings).map(([key, value]) => `
        <div class="field">
          <label for="setting_${key}">${escapeHtml(key.replace(/_/g, " "))}</label>
          <div class="cluster" style="flex-wrap:nowrap;">
            <input id="setting_${key}" value="${escapeHtml(String(value))}" />
            <button class="btn secondary" style="flex:0 0 auto;" onclick="saveSetting('${key}')">Save</button>
          </div>
        </div>`).join("")}
    </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}
async function saveSetting(key) {
  const raw = document.getElementById(`setting_${key}`).value;
  const value = raw.trim() === "" || isNaN(Number(raw)) ? raw : Number(raw);
  try { await Api.put(`/admin/settings/${key}`, { value }); notify("Setting saved."); }
  catch (err) { notify(err.message, "error"); }
}

// ------------------------------------------------------------------ router
Router.register("overview", renderOverview);
Router.register("semesters", renderSemesters);
Router.register("lecturers", renderLecturers);
Router.register("students", renderStudents);
Router.register("settings", renderSettings);
Router.init(document.getElementById("outlet"), { notFound: () => Router.go("overview") });
if (!location.hash) Router.go("overview");