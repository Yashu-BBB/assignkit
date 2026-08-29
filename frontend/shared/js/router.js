/**
 * Minimal hash router. Each role app registers routes like:
 *   Router.register("dashboard", renderDashboard);
 *   Router.register("subject/:id", renderSubject);
 * Routes are matched against location.hash (e.g. #subject/abc-123).
 * This keeps navigation bookmarkable/shareable and avoids a build step —
 * appropriate for the plain HTML/CSS/JS stack specified.
 */
const Router = (() => {
  const routes = [];
  let outlet = null;
  let onNavigate = null;

  function register(pattern, handler) {
    const paramNames = [];
    const regex = new RegExp(
      "^" + pattern.replace(/:[^/]+/g, (m) => { paramNames.push(m.slice(1)); return "([^/]+)"; }) + "$"
    );
    routes.push({ regex, paramNames, handler });
  }

  function init(outletEl, { notFound, beforeEach } = {}) {
    outlet = outletEl;
    onNavigate = beforeEach;
    window.addEventListener("hashchange", () => resolve(notFound));
    resolve(notFound);
  }

  function resolve(notFound) {
    const hash = (location.hash || "#").slice(1).replace(/^\//, "");
    if (onNavigate) onNavigate(hash);

    for (const r of routes) {
      const match = hash.match(r.regex);
      if (match) {
        const params = {};
        r.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
        outlet.innerHTML = "";
        r.handler(params, outlet);
        highlightNav(hash);
        return;
      }
    }
    if (notFound) { outlet.innerHTML = ""; notFound(outlet); }
  }

  function highlightNav(hash) {
    document.querySelectorAll(".nav-link[data-route]").forEach((el) => {
      const base = el.dataset.route.split("/:")[0];
      el.classList.toggle("active", hash === el.dataset.route || hash.startsWith(base));
    });
  }

  function go(path) { location.hash = "#" + path; }

  return { register, init, go };
})();
