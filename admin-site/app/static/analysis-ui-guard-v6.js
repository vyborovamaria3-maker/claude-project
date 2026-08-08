(() => {
  const trackedFetch = window.fetch.bind(window);
  let loadCount = 0;
  let mutationCount = 0;
  let toggleBusy = false;

  const requestInfo = (input, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const raw = typeof input === "string" ? input : String(input?.url || "");
    const path = raw.split("?", 1)[0];
    const isAnalysis = raw.includes("/api/analysis-profiles");
    const isBacktest = path.endsWith("/backtest");
    const mutation = isAnalysis && !isBacktest && ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const listLoad = isAnalysis && method === "GET" && path.endsWith("/api/analysis-profiles");
    return { mutation, listLoad };
  };

  window.fetch = async function guardedAnalysisFetch(input, init = {}) {
    const info = requestInfo(input, init);
    if (info.mutation) mutationCount += 1;
    if (info.listLoad) loadCount += 1;
    try {
      return await trackedFetch(input, init);
    } finally {
      if (info.mutation) mutationCount = Math.max(0, mutationCount - 1);
      if (info.listLoad) loadCount = Math.max(0, loadCount - 1);
    }
  };

  function notify(message, isError = false) {
    if (typeof window.toast === "function") {
      window.toast(message, isError);
      return;
    }
    const el = document.querySelector("#toast");
    if (!el) return;
    el.textContent = message;
    el.className = `toast show${isError ? " error" : ""}`;
    window.setTimeout(() => { el.className = "toast"; }, 2200);
  }

  async function jsonRequest(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try { detail = (await response.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    return response.json();
  }

  function activeDomain() {
    return document.querySelector(".analysis-tab.active[data-domain]")?.dataset.domain || "";
  }

  document.addEventListener("click", (event) => {
    const navigation = event.target.closest?.(".analysis-tab[data-domain], #navigation [data-view], #refreshButton");
    if (!navigation) return;
    if (!loadCount && !mutationCount && !toggleBusy) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    notify("Дождитесь завершения текущей операции");
  }, true);

  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-toggle]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (toggleBusy || mutationCount > 0) {
      notify("Изменение уже выполняется");
      return;
    }

    const domain = activeDomain();
    const key = button.dataset.toggle || "";
    if (!domain || !key) return;
    toggleBusy = true;
    button.disabled = true;
    try {
      const snapshot = await jsonRequest(`/api/analysis-profiles?domain=${encodeURIComponent(domain)}`);
      const row = (snapshot.rows || []).find((item) => item.key === key);
      if (!row || row.hidden || row.runtime_state === "legacy") {
        throw new Error("Параметр больше недоступен для переключения");
      }
      const nextEnabled = !Boolean(row.enabled);
      const accepted = await window.AdminAnalysisConfirm?.ask({
        title: "Подтвердить переключение",
        danger: false,
        changes: [
          ["Раздел", domain],
          ["Параметр", key],
          ["Selected", `${row.enabled ? "ON" : "OFF"} → ${nextEnabled ? "ON" : "OFF"}`],
          ["Threshold", row.threshold || "—"],
        ],
      });
      if (!accepted) return;
      await jsonRequest(`/api/analysis-profiles/${encodeURIComponent(domain)}/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: nextEnabled, threshold: row.threshold || "" }),
        __analysisConfirmed: true,
      });
      if (activeDomain() === domain) await window.AdminAnalysisProfiles?.reload();
      notify(`${row.label}: ${nextEnabled ? "ON" : "OFF"}`);
    } catch (error) {
      notify(error.message || "Не удалось изменить параметр", true);
      if (activeDomain() === domain) await window.AdminAnalysisProfiles?.reload();
    } finally {
      toggleBusy = false;
    }
  }, true);
})();