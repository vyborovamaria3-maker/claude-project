(() => {
  const STORAGE_KEY = "potapoff-admin.theme-preset";
  const themes = [
    ["market-amber","Market Amber","#17120a","#110d07","#241c10","#42301a","#f59e0b"],
    ["wine-dark","Wine Dark","#180a0e","#100609","#221014","#381820","#f43f5e"],
    ["burgundy-noir","Burgundy Noir","#1a0c10","#12080b","#26121a","#3e1c28","#fda4af"],
    ["crimson-noir","Crimson Noir","#160d0f","#100809","#22141a","#3d202a","#fca5a5"],
    ["rose-nebula","Rose Nebula","#160f1a","#100b13","#241521","#42283a","#fb7185"],
    ["neon-ember","Neon Ember","#181008","#110b05","#27190f","#47301b","#f97316"],
    ["royal-plum","Royal Plum","#160f20","#100b18","#221830","#3d2b55","#d8b4fe"],
    ["lavender-haze","Lavender Haze","#14102a","#0e0b1e","#1e1938","#302850","#c4b5fd"],
    ["cobalt-night","Cobalt Night","#08111f","#050b15","#111b2d","#1a2e4a","#60a5fa"],
    ["deep-space","Deep Space","#0a0c18","#060810","#121525","#1e2140","#a5b4fc"],
    ["slate-ocean","Slate Ocean","#0f1520","#0a0f18","#182030","#243044","#93c5fd"],
    ["ocean-depth","Ocean Depth","#091520","#060f18","#101d2c","#1a2d40","#38bdf8"],
    ["aurora-mist","Aurora Mist","#071714","#04110f","#0f231f","#1d4038","#2dd4bf"],
    ["emerald-abyss","Emerald Abyss","#0c1a17","#081210","#142822","#214d3d","#6ee7b7"],
    ["forest-pine","Forest Pine","#0b1710","#07100b","#12221a","#1e3d2a","#86efac"],
    ["deep-jungle","Deep Jungle","#091510","#060f0a","#101e16","#1a3020","#4ade80"],
    ["teal-smoke","Teal Smoke","#0a1818","#071010","#122222","#1c3434","#5eead4"],
    ["amber-dusk","Amber Dusk","#17120a","#110d07","#241c10","#42301a","#fcd34d"],
    ["solar-flare","Solar Flare","#180f07","#110a04","#251710","#3d2410","#fdba74"],
    ["golden-hour","Golden Hour","#191107","#120c05","#281b0f","#47331b","#f59e0b"],
    ["graphite","Graphite","#111318","#0c0e12","#1a1d24","#272b35","#93c5fd"],
    ["zinc-dark","Zinc Dark","#121214","#0d0d0f","#1c1c20","#2c2c32","#a1a1aa"]
  ].map(([id,name,bg,bgSoft,bgCard,border,accent]) => ({id,name,bg,bgSoft,bgCard,border,accent}));
  const groups = [
    ["Винные / Тёплые", ["market-amber","wine-dark","burgundy-noir","crimson-noir","rose-nebula","neon-ember","amber-dusk","solar-flare","golden-hour"]],
    ["Фиолетовые / Синие", ["royal-plum","lavender-haze","cobalt-night","deep-space","slate-ocean","ocean-depth"]],
    ["Зелёные", ["aurora-mist","emerald-abyss","forest-pine","deep-jungle","teal-smoke"]],
    ["Нейтральные", ["graphite","zinc-dark"]]
  ];
  const escapeHtml = (value) => String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  const findTheme = (id) => themes.find((t) => t.id === id) || themes.find((t) => t.id === "emerald-abyss");
  function applyTheme(theme) {
    const root = document.documentElement;
    root.dataset.adminTheme = theme.id;
    root.style.setProperty("--bg", theme.bg);
    root.style.setProperty("--panel", theme.bgCard);
    root.style.setProperty("--panel-2", theme.bgSoft);
    root.style.setProperty("--line", theme.border);
    root.style.setProperty("--green", theme.accent);
    root.style.setProperty("--green-2", theme.accent);
    try { localStorage.setItem(STORAGE_KEY, theme.id); } catch {}
    document.querySelectorAll(".theme-option").forEach((el) => el.classList.toggle("active", el.dataset.themeId === theme.id));
    const current = document.querySelector("#themeCurrentName"); if (current) current.textContent = theme.name;
    const dot = document.querySelector("#themeTriggerDot"); if (dot) dot.style.background = theme.accent;
  }
  function buildPicker() {
    const actions = document.querySelector(".topbar-actions");
    if (!actions || document.querySelector("#themePickerButton")) return;
    const button = document.createElement("button");
    button.id = "themePickerButton"; button.className = "secondary theme-trigger"; button.type = "button";
    button.innerHTML = '<span id="themeTriggerDot" class="theme-trigger-dot"></span><span>Цвет</span>';
    actions.insertBefore(button, actions.firstChild);
    const panel = document.createElement("div"); panel.id = "themePickerPanel"; panel.className = "theme-panel";
    panel.innerHTML = `<div class="theme-card" role="dialog" aria-modal="true" aria-label="Цветовая тема"><div class="theme-card-head"><div><p class="eyebrow">APPEARANCE</p><h3>Цветовая тема админки</h3></div><button id="themePickerClose" class="theme-close" type="button">Закрыть</button></div><div class="theme-current">Текущая тема: <b id="themeCurrentName"></b></div>${groups.map(([label, ids]) => `<section class="theme-group"><p class="theme-group-title">${escapeHtml(label)}</p><div class="theme-grid">${ids.map((id) => { const t=findTheme(id); return `<button type="button" class="theme-option" data-theme-id="${t.id}"><span class="theme-swatch" style="background:linear-gradient(135deg,${t.bg} 0 54%,${t.accent} 55% 100%)"></span><span><strong>${escapeHtml(t.name)}</strong><small>${t.bg} · ${t.accent}</small></span></button>`; }).join("")}</div></section>`).join("")}</div>`;
    document.body.appendChild(panel);
    const close=()=>panel.classList.remove("open"); button.addEventListener("click",()=>panel.classList.add("open")); panel.querySelector("#themePickerClose").addEventListener("click",close); panel.addEventListener("click",(e)=>{if(e.target===panel)close(); const option=e.target.closest?.("[data-theme-id]"); if(option)applyTheme(findTheme(option.dataset.themeId));}); document.addEventListener("keydown",(e)=>{if(e.key==="Escape")close();});
  }
  let stored=null; try { stored=localStorage.getItem(STORAGE_KEY); } catch {}
  applyTheme(findTheme(stored || "emerald-abyss"));
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{buildPicker();applyTheme(findTheme(stored||"emerald-abyss"));}); else {buildPicker();applyTheme(findTheme(stored||"emerald-abyss"));}
})();
