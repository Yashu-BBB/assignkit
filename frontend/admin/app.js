if (!Auth.isLoggedIn() || Auth.role() !== "admin") {
  window.location.href = "../index.html";
}
document.getElementById("userPill").textContent = Auth.name();

function setCrumb(t) { document.getElementById("crumb").innerHTML = `<h2>${t}</h2>`; }
function loadingBlock() { return `<div class="loading"><div class="spinner"></div>Loading…</div>`; }
function errorBlock(err) { return `<div class="error-banner">${err.message || "Something went wrong."}</div>`; }
function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str || ""; return d.innerHTML; }

// --------------------------------------------------------------- overview
async function renderOverview(_, outlet) {
  setCrumb("System Overview");
  outlet.innerHTML = loadingBlock();
  try {
    const s = await Api.get("/admin/analytics/overview");
    outlet.innerHTML = `<div class="grid grid-3">
      <div class="card stat"><div class="value">${s.active_students}</div><div class="label">Active Students</div></div>
      <div class="card stat"><div class="value">${s.active_lecturers}</div><div class="label">Active Lecturers</div></div>
      <div class="card stat"><div class="value">${s.total_assignments}</div><div class="label">Assignments</div></div>
      <div class="card stat"><div class="value">${s.ai_generated_questions}</div><div class="label">AI-Generated Questions</div></div>
      <div class="card stat"><div class="value">${s.ai_calls_total}</div><div class="label">Total AI Calls</div></div>
      <div class="card stat"><div class="value">${s.ai_failures}</div><div class="label">AI Failures</div></div>
    </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

// ------------------------------------------------------- semesters/sections
async function renderSemesters(_, outlet) {
  setCrumb("Semesters & Sections");
  outlet.innerHTML = loadingBlock();
  try {
    const semesters = await Api.get("/admin/semesters");
    const rows = await Promise.all(semesters.map(async s => {
      const sections = await Api.get(`/admin/sections?semester_id=${s.id}`);
      return { s, sections };
    }));
    outlet.innerHTML = rows.map(({ s, sections }) => `
      <div class="card">
        <h3>${escapeHtml(s.name)}</h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          ${sections.map(sec => `<span class="badge neutral">${escapeHtml(sec.name)}</span>`).join("") || '<span style="color:var(--ink-soft); font-size:.85rem;">No sections yet</span>'}
        </div>
        <div class="field-row" style="align-items:flex-end;">
          <div class="field" style="flex:0 0 160px;"><label>New section name</label><input id="sec_${s.id}" placeholder="e.g. A" /></div>
          <button class="btn secondary" onclick="addSection('${s.id}')">Add Section</button>
        </div>
      </div>`).join("") + `
      <div class="card">
        <h3>Add semester</h3>
        <div class="field-row" style="align-items:flex-end;">
          <div class="field"><label>Semester name</label><input id="newSemName" placeholder="e.g. Semester 5, 2026" /></div>
          <button class="btn" onclick="addSemester()">Add Semester</button>
        </div>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function addSemester() {
  const name = document.getElementById("newSemName").value.trim();
  if (!name) return;
  await Api.post("/admin/semesters", { name });
  renderSemesters({}, document.getElementById("outlet"));
}
async function addSection(semesterId) {
  const name = document.getElementById(`sec_${semesterId}`).value.trim();
  if (!name) return;
  await Api.post("/admin/sections", { semester_id: semesterId, name });
  renderSemesters({}, document.getElementById("outlet"));
}

// ------------------------------------------------------------------ lecturers
async function renderLecturers(_, outlet) {
  setCrumb("Lecturers");
  outlet.innerHTML = loadingBlock();
  try {
    const lecturers = await Api.get("/admin/lecturers");
    outlet.innerHTML = `
      <table><thead><tr><th>Lecturer ID</th><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead>
      <tbody>${lecturers.map(l => `<tr>
        <td>${escapeHtml(l.lecturer_id)}</td><td>${escapeHtml(l.full_name)}</td><td>${escapeHtml(l.email || "")}</td>
        <td><span class="badge ${l.is_active ? 'ok' : 'err'}">${l.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn secondary" onclick="resetPassword('${l.id}','lecturer')">Reset Password</button>
          <button class="btn danger" onclick="deactivateLecturer('${l.id}')">Deactivate</button>
        </td>
      </tr>`).join("")}</tbody></table>
      <div class="card" style="margin-top:18px; max-width:420px;">
        <h3>Add lecturer</h3>
        <div class="field"><label>Lecturer ID</label><input id="l_id" /></div>
        <div class="field"><label>Full name</label><input id="l_name" /></div>
        <div class="field"><label>Email (optional)</label><input id="l_email" /></div>
        <div class="field"><label>Temporary password</label><input id="l_pass" type="text" /></div>
        <button class="btn" onclick="createLecturer()">Create Lecturer</button>
      </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}

async function createLecturer() {
  try {
    await Api.post("/admin/lecturers", {
      lecturer_id: document.getElementById("l_id").value.trim(),
      full_name: document.getElementById("l_name").value.trim(),
      email: document.getElementById("l_email").value.trim() || null,
      password: document.getElementById("l_pass").value,
    });
    renderLecturers({}, document.getElementById("outlet"));
  } catch (err) { alert(err.message); }
}
async function deactivateLecturer(id) {
  if (!confirm("Deactivate this lecturer?")) return;
  await Api.del(`/admin/lecturers/${id}`);
  renderLecturers({}, document.getElementById("outlet"));
}

// -------------------------------------------------------------------- students
async function renderStudents(_, outlet) {
  setCrumb("Students");
  outlet.innerHTML = loadingBlock();
  try {
    const [students, semesters] = await Promise.all([
      Api.get("/admin/students"), Api.get("/admin/semesters"),
    ]);
    outlet.innerHTML = `
      <table><thead><tr><th>Register No.</th><th>Name</th><th>Status</th><th></th></tr></thead>
      <tbody>${students.map(s => `<tr>
        <td>${escapeHtml(s.register_number)}</td><td>${escapeHtml(s.full_name)}</td>
        <td><span class="badge ${s.is_active ? 'ok' : 'err'}">${s.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn secondary" onclick="resetPassword('${s.id}','student')">Reset Password</button>
          <button class="btn danger" onclick="deactivateStudent('${s.id}')">Deactivate</button>
        </td>
      </tr>`).join("")}</tbody></table>

      <div class="card" style="margin-top:18px; max-width:480px;">
        <h3>Add student</h3>
        <div class="field"><label>Register number</label><input id="s_reg" /></div>
        <div class="field"><label>Full name</label><input id="s_name" /></div>
        <div class="field"><label>Semester</label>
          <select id="s_sem" onchange="loadSectionsFor('s_sem','s_sec')">
            ${semesters.map(sem => `<option value="${sem.id}">${escapeHtml(sem.name)}</option>`).join("")}
          </select></div>
        <div class="field"><label>Section</label><select id="s_sec"></select></div>
        <div class="field"><label>Temporary password</label><input id="s_pass" /></div>
        <button class="btn" onclick="createStudent()">Create Student</button>
      </div>

      <div class="card" style="margin-top:18px; max-width:480px;">
        <h3>Bulk upload (CSV)</h3>
        <p style="font-size:.82rem; color:var(--ink-soft);">
          Columns: register_number, full_name, password, semester_id, section_id
        </p>
        <input type="file" id="bulkCsv" accept=".csv" />
        <button class="btn secondary" style="margin-left:8px;" onclick="bulkUploadStudents()">Upload</button>
        <div id="bulkStatus" style="margin-top:8px; font-size:.85rem;"></div>
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
      register_number: document.getElementById("s_reg").value.trim(),
      full_name: document.getElementById("s_name").value.trim(),
      password: document.getElementById("s_pass").value,
      semester_id: document.getElementById("s_sem").value,
      section_id: document.getElementById("s_sec").value,
    });
    renderStudents({}, document.getElementById("outlet"));
  } catch (err) { alert(err.message); }
}
async function deactivateStudent(id) {
  if (!confirm("Deactivate this student?")) return;
  await Api.del(`/admin/students/${id}`);
  renderStudents({}, document.getElementById("outlet"));
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
  if (!fileInput.files.length) return alert("Choose a CSV file first.");
  const text = await fileInput.files[0].text();
  const rows = parseCsv(text);
  try {
    const created = await Api.post("/admin/students/bulk", { students: rows });
    statusEl.innerHTML = `<span class="badge ok">Created ${created.length} of ${rows.length}</span>`;
    renderStudents({}, document.getElementById("outlet"));
  } catch (err) { statusEl.innerHTML = `<span class="badge err">${err.message}</span>`; }
}

async function resetPassword(userId, role) {
  const newPassword = prompt(`Enter a new password for this ${role}:`);
  if (!newPassword) return;
  await Api.post("/auth/reset-password", { user_id: userId, role, new_password: newPassword });
  alert("Password reset.");
}

// -------------------------------------------------------------------- settings
async function renderSettings(_, outlet) {
  setCrumb("System Settings");
  outlet.innerHTML = loadingBlock();
  try {
    const settings = await Api.get("/admin/settings");
    outlet.innerHTML = `<div class="card" style="max-width:480px;">
      ${Object.entries(settings).map(([key, value]) => `
        <div class="field">
          <label>${key.replace(/_/g, " ")}</label>
          <div style="display:flex; gap:8px;">
            <input id="setting_${key}" value="${escapeHtml(String(value))}" />
            <button class="btn secondary" onclick="saveSetting('${key}')">Save</button>
          </div>
        </div>`).join("")}
    </div>`;
  } catch (err) { outlet.innerHTML = errorBlock(err); }
}
async function saveSetting(key) {
  const raw = document.getElementById(`setting_${key}`).value;
  const value = isNaN(Number(raw)) ? raw : Number(raw);
  await Api.put(`/admin/settings/${key}`, { value });
  alert("Setting updated.");
}

// ------------------------------------------------------------------ router
Router.register("overview", renderOverview);
Router.register("semesters", renderSemesters);
Router.register("lecturers", renderLecturers);
Router.register("students", renderStudents);
Router.register("settings", renderSettings);
Router.init(document.getElementById("outlet"), { notFound: () => Router.go("overview") });
if (!location.hash) Router.go("overview");
