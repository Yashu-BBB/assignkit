/**
 * Thin fetch wrapper for the backend API.
 * - Attaches the bearer token from localStorage automatically.
 * - Normalizes error responses into a single shape the UI can render.
 * - Centralizes the API base URL (set window.API_BASE before this loads,
 *   or it defaults to same-origin `/api`, matching the Railway deploy).
 */
const API_BASE = window.API_BASE || "/api";

const Auth = {
  TOKEN_KEY: "acap_token",
  ROLE_KEY: "acap_role",
  ID_KEY: "acap_id",
  NAME_KEY: "acap_name",

  save(session) {
    localStorage.setItem(this.TOKEN_KEY, session.access_token);
    localStorage.setItem(this.ROLE_KEY, session.role);
    localStorage.setItem(this.ID_KEY, session.id);
    localStorage.setItem(this.NAME_KEY, session.full_name);
  },
  token() { return localStorage.getItem(this.TOKEN_KEY); },
  role() { return localStorage.getItem(this.ROLE_KEY); },
  name() { return localStorage.getItem(this.NAME_KEY); },
  isLoggedIn() { return !!this.token(); },
  logout() {
    [this.TOKEN_KEY, this.ROLE_KEY, this.ID_KEY, this.NAME_KEY].forEach(k => localStorage.removeItem(k));
    window.location.href = "/index.html";
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
    throw new ApiError(err?.code || "error", err?.message || "Something went wrong.", res.status);
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
