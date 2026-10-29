(() => {
  const configured = document.querySelector('meta[name="potapoff-site-url"]')?.content || "";
  let base;
  try {
    base = new URL(configured);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) base = null;
  } catch { base = null; }
  for (const link of document.querySelectorAll("[data-analysis-section]")) {
    if (!base) {
      link.setAttribute("aria-disabled", "true");
      link.title = "Адрес основного сайта ещё не настроен";
      continue;
    }
    const url = new URL("/trade/analysis", base);
    url.searchParams.set("section", link.dataset.analysisSection);
    link.href = url.href;
  }
})();
