(() => {
  "use strict";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference;
  try { preference = localStorage.getItem("quiz-theme"); } catch {}
  if (!["light", "dark"].includes(preference)) preference = null;
  function apply() {
    const dark = preference ? preference === "dark" : system.matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const button = document.getElementById("theme-toggle");
    if (button) {
      button.textContent = dark ? "Светъл режим" : "Тъмен режим";
      button.setAttribute("aria-pressed", String(dark));
    }
  }
  apply();
  system.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("theme-toggle").addEventListener("click", () => {
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem("quiz-theme", preference); } catch {}
      apply();
    });
  });
})();
