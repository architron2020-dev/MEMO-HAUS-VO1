// Dark/light theme toggle, shared across every mobile page (upload, contribute,
// memories). The actual theme attribute is already applied pre-paint by the
// inline script in each page's <head> — this just keeps the toggle button's
// icon and the logo variant in sync, and persists future choices.
const LOGO_DARK = "/logo.svg";
const LOGO_LIGHT = "/logo-light.svg";

export function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const logoEls = document.querySelectorAll("img.upload-logo, img.placeholder-logo");

  function sync() {
    const isLight = document.documentElement.dataset.theme === "light";
    btn.textContent = isLight ? "☀️" : "🌙";
    logoEls.forEach(img => { img.src = isLight ? LOGO_LIGHT : LOGO_DARK; });
  }
  sync();

  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("memo-theme", next);
    sync();
  });
}
