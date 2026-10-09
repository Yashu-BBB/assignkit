// Mobile menu for the top bar. Closes itself when you pick a page.
(function () {
  const btn = document.getElementById("menuBtn");
  const nav = document.getElementById("mainNav");
  if (!btn || !nav) return;
  function setOpen(open) {
    nav.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Close" : "Menu";
  }
  btn.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
  window.addEventListener("hashchange", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
})();

// Show who is signed in (desktop and the mobile menu).
(function () {
  if (typeof Auth === "undefined") return;
  const n = Auth.name() || "";
  ["userPill", "userPillMobile"].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = n; });
})();