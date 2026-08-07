(() => {
  const STORAGE_KEY = "potapoff-admin.theme-preset";
  const themes = [
    ["market-amber","Market Amber"],["wine-dark","Wine Dark"],["burgundy-noir","Burgundy Noir"],["crimson-noir","Crimson Noir"],["rose-nebula","Rose Nebula"],["neon-ember","Neon Ember"],
    ["royal-plum","Royal Plum"],["lavender-haze","Lavender Haze"],["cobalt-night","Cobalt Night"],["deep-space","Deep Space"],["slate-ocean","Slate Ocean"],["ocean-depth","Ocean Depth"],
    ["aurora-mist","Aurora Mist"],["emerald-abyss","Emerald Abyss"],["forest-pine","Forest Pine"],["deep-jungle","Deep Jungle"],["teal-smoke","Teal Smoke"],
    ["amber-dusk","Amber Dusk"],["solar-flare","Solar Flare"],["golden-hour","Golden Hour"],["graphite","Graphite"],["zinc-dark","Zinc Dark"]
  ].map(([id,name]) => ({id,name}));
  const groups = [
    ["Винные / Тёплые", ["market-amber","wine-dark","burgundy-noir","crimson-noir","rose-nebula","neon-ember","amber-dusk","solar-flare","golden-hour"]],
    ["Фиолетовые / Синие", ["royal-plum","lavender-haze","cobalt-night","deep-space","slate-ocean","ocean-depth"]],
    ["Зелёные", ["aurora-mist","emerald-abyss","forest-pine","deep-jungle","teal-smoke"]],
    ["Нейтральные", ["graphite","zinc-dark"]]
  ];
  const escapeHtml = (value) => String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  const findTheme = (id) => themes.find((theme) => theme.id === id) || themes.find((theme) => theme.id === "emerald-abyss");

  function applyTheme(theme) {
    document.documentElement.dataset.adminTheme = theme.id;
    try { localStorage.setItem(STORAGE_KEY, theme.id); } catch {}
    document.querySelectorAll(".theme-option").forEach((el) => el.classList.toggle("active", el.dataset.themeId === theme.id));
    const current = document.querySelector("#themeCurrentName");
    if (current) current.textContent = theme.name;
  }

  function buildPicker() {
    const actions = document.querySelector(".topbar-actions");
    if (!actions || document.querySelector("#themePickerButton")) return;
    const button = document.createElement("button");
    button.id = "themePickerButton";
    button.className = "secondary theme-trigger";
    button.type = "button";
    button.innerHTML = '<span class="theme-trigger-dot"></span><span>Цвет</span>';
    actions.insertBefore(button, actions.firstChild);

    const panel = document.createElement("div");
    panel.id = "themePickerPanel";
    panel.className = "theme-panel";
    panel.innerHTML = `<div class="theme-card" role="dialog" aria-modal="true" aria-label="Цветовая тема">
      <div class="theme-card-head"><div><p class="eyebrow">APPEARANCE</p><h3>Цветовая тема админки</h3></div><button id="themePickerClose" class="theme-close" type="button">Закрыть</button></div>
      <div class="theme-current">Текущая тема: <b id="themeCurrentName"></b></div>
      ${groups.map(([label, ids]) => `<section class="theme-group"><p class="theme-group-title">${escapeHtml(label)}</p><div class="theme-grid">${ids.map((id) => {
        const theme = findTheme(id);
        return `<button type="button" class="theme-option" data-theme-id="${theme.id}"><span class="theme-swatch"></span><span><strong>${escapeHtml(theme.name)}</strong><small>${escapeHtml(theme.id)}</small></span></button>`;
      }).join("")}</div></section>`).join("")}
    </div>`;
    document.body.appendChild(panel);

    const close = () => panel.classList.remove("open");
    button.addEventListener("click", () => panel.classList.add("open"));
    panel.querySelector("#themePickerClose").addEventListener("click", close);
    panel.addEventListener("click", (event) => {
      if (event.target === panel) close();
      const option = event.target.closest?.("[data-theme-id]");
      if (option) applyTheme(findTheme(option.dataset.themeId));
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  }

  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
  const initial = findTheme(stored || "emerald-abyss");
  applyTheme(initial);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { buildPicker(); applyTheme(initial); });
  else { buildPicker(); applyTheme(initial); }
})();
