/**
 * Thin fetch wrapper for the backend API.
 * - Attaches the bearer token from sessionStorage automatically.
 * - Normalizes error responses into a single shape the UI can render.
 * - Centralizes the API base URL (set window.API_BASE before this loads,
 *   or it defaults to same-origin `/api`, matching the Railway deploy).
 *
 * NOTE: session data is intentionally kept in sessionStorage, NOT
 * localStorage. localStorage is shared across every tab of the same
 * origin, so logging in as a different user in a second tab would
 * silently overwrite the first tab's session — a refresh in tab 1
 * would then show the second user's dashboard. sessionStorage is
 * scoped per-tab, so each tab keeps its own independent session.
 */
const API_BASE = window.API_BASE || "/api";

const Auth = {
  TOKEN_KEY: "acap_token",
  ROLE_KEY: "acap_role",
  ID_KEY: "acap_id",
  NAME_KEY: "acap_name",

  save(session) {
    sessionStorage.setItem(this.TOKEN_KEY, session.access_token);
    sessionStorage.setItem(this.ROLE_KEY, session.role);
    sessionStorage.setItem(this.ID_KEY, session.id);
    sessionStorage.setItem(this.NAME_KEY, session.full_name);
  },
  token() { return sessionStorage.getItem(this.TOKEN_KEY); },
  role() { return sessionStorage.getItem(this.ROLE_KEY); },
  name() { return sessionStorage.getItem(this.NAME_KEY); },
  isLoggedIn() { return !!this.token(); },
  logout() {
    const wasAdmin = this.role() === "admin";
    [this.TOKEN_KEY, this.ROLE_KEY, this.ID_KEY, this.NAME_KEY].forEach(k => sessionStorage.removeItem(k));
    window.location.href = wasAdmin ? "/admin/login.html" : "/index.html";
  },
};

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function apiRequest(method, path, body, { isForm = false } = {}) {
  const headers = {};
  const token = Auth.token();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
  });

  if (res.status === 204) return null;

  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const data = isJson ? await res.json() : await res.blob();

  if (!res.ok) {
    if (res.status === 401) {
      Auth.logout();
      return;
    }
    const err = isJson ? data.error : { code: "error", message: "Request failed." };
    let message = err?.message || "Something went wrong.";
    // For 422s, err.fields holds pydantic's per-field validation errors
    // (e.g. "counts must equal total_questions"). Append them so the
    // alert actually tells you what's wrong, not just "Invalid request data."
    if (Array.isArray(err?.fields) && err.fields.length) {
      const details = err.fields.map(f => {
        const loc = Array.isArray(f.loc) ? f.loc.filter(p => p !== "body").join(".") : "";
        return loc ? `${loc}: ${f.msg}` : f.msg;
      }).join("\n");
      message += "\n\n" + details;
    }
    throw new ApiError(err?.code || "error", message, res.status);
  }
  return data;
}

const Api = {
  get: (path) => apiRequest("GET", path),
  post: (path, body, opts) => apiRequest("POST", path, body, opts),
  put: (path, body) => apiRequest("PUT", path, body),
  patch: (path, body) => apiRequest("PATCH", path, body),
  del: (path) => apiRequest("DELETE", path),
};