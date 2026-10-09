/**
 * Small helpers shared by the three apps: escaping, page heading, loading and
 * error blocks, toasts, and a table builder that labels every cell so the
 * table can collapse into stacked rows on phones (see styles.css).
 */
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

/** Sets the page heading. `back` is optional: { href, label }. */
function setCrumb(title, lede, back) {
  const el = document.getElementById("crumb");
  el.innerHTML =
    (back ? `<a class="back" href="${back.href}">← ${escapeHtml(back.label)}</a>` : "") +
    `<h1>${escapeHtml(title)}</h1>` +
    (lede ? `<p class="lede">${escapeHtml(lede)}</p>` : "");
  document.title = `${title} · AssignKit`;
  window.scrollTo(0, 0);
}

function loadingBlock() {
  return `<div class="loading" role="status"><div class="spinner"></div>Loading…</div>`;
}
function errorBlock(err) {
  return `<div class="error-banner" role="alert">${escapeHtml((err && err.message) || "Something went wrong.")}</div>`;
}

function notify(message, kind) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = "toast" + (kind === "error" ? " error" : "");
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? 6500 : 3500);
}

/**
 * columns: [{ label, cls? }]   rows: array of arrays of ready-made HTML strings.
 * A cell may be { html, cls } to add a class (e.g. "actions").
 */
function tableHtml(columns, rows, emptyHtml) {
  if (!rows.length && emptyHtml) return emptyHtml;
  const head = columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join("");
  const body = rows.map(r => `<tr>${r.map((cell, i) => {
    const html = typeof cell === "object" && cell !== null ? cell.html : cell;
    const cls = typeof cell === "object" && cell !== null && cell.cls ? ` class="${cell.cls}"` : "";
    return `<td data-label="${escapeHtml(columns[i].label)}"${cls}>${html}</td>`;
  }).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const UNAVAILABLE_CHIP = `<span class="chip-off">Temporarily unavailable</span>`;