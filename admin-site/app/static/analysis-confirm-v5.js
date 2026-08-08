(() => {
  const nativeFetch = window.fetch.bind(window);
  let pending = null;
  let clickBypass = false;
  let preconfirmedMutation = false;

  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function isAnalysisMutation(input, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const url = typeof input === "string" ? input : String(input?.url || "");
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
    if (!url.includes("/api/analysis-profiles/")) return false;
    if (url.endsWith("/backtest")) return false;
    return true;
  }

  function parseBody(init) {
    if (!init?.body || typeof init.body !== "string") return null;
    try { return JSON.parse(init.body); } catch { return null; }
  }

  function describe(input, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    const url = typeof input === "string" ? input : String(input?.url || "");
    const body = parseBody(init);
    const parts = url.split("/").filter(Boolean);
    const apiIndex = parts.indexOf("analysis-profiles");
    const domain = apiIndex >= 0 ? parts[apiIndex + 1] || "" : "";
    const key = apiIndex >= 0 ? parts[apiIndex + 2] || "" : "";
    const suffix = apiIndex >= 0 ? parts[apiIndex + 3] || "" : "";
    let title = "Подтвердить изменение";
    let danger = false;
    const changes = [];

    if (method === "DELETE" || suffix === "entry") {
      title = "Подтвердить удаление";
      danger = true;
      changes.push(["Действие", "Удаление / скрытие параметра"]);
    } else if (suffix === "restore") {
      title = "Подтвердить восстановление";
      changes.push(["Действие", "Восстановить параметр"]);
    } else if (method === "POST" && !key) {
      title = "Подтвердить создание параметра";
      changes.push(["Действие", "Создать новый параметр"]);
    } else if (method === "PUT" && body && Object.prototype.hasOwnProperty.call(body, "enabled")) {
      title = "Подтвердить переключение";
      changes.push(["Selected", body.enabled ? "ON" : "OFF"]);
      if (body.threshold !== undefined) changes.push(["Threshold", body.threshold || "—"]);
    } else if (method === "PATCH") {
      title = "Подтвердить изменения параметра";
    }

    if (domain) changes.unshift(["Раздел", domain]);
    if (key) changes.push(["Параметр", decodeURIComponent(key)]);
    if (body) {
      const labels = { label: "Название", source: "Source path", value_type: "Тип", scale: "Scale", threshold: "Threshold", description: "Описание", enabled: "Selected", key: "Key" };
      for (const [field, label] of Object.entries(labels)) {
        if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
        if (field === "enabled" && changes.some(([name]) => name === "Selected")) continue;
        const value = field === "enabled" ? (body[field] ? "ON" : "OFF") : (body[field] || "—");
        changes.push([label, String(value)]);
      }
    }
    return { title, danger, changes };
  }

  function ensureModal() {
    let modal = document.getElementById("analysisConfirmModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "analysisConfirmModal";
    modal.className = "analysis-confirm-modal hidden";
    modal.innerHTML = `
      <section class="analysis-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="analysisConfirmTitle">
        <div class="analysis-confirm-head"><div><p class="analysis-confirm-kicker">CONTROL CENTER</p><h3 id="analysisConfirmTitle">Подтвердить изменение</h3></div></div>
        <div class="analysis-confirm-body">
          <p>Проверьте изменения перед применением. До подтверждения запрос на сервер не отправляется.</p>
          <div id="analysisConfirmChanges" class="analysis-confirm-changes"></div>
          <div class="analysis-confirm-warning">Изменение будет записано в audit trail.</div>
        </div>
        <div class="analysis-confirm-actions">
          <button id="analysisConfirmCancel" class="secondary" type="button">Отмена</button>
          <button id="analysisConfirmAccept" class="primary" type="button">Подтвердить</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    modal.querySelector("#analysisConfirmCancel").addEventListener("click", () => settle(false));
    modal.querySelector("#analysisConfirmAccept").addEventListener("click", () => settle(true));
    modal.addEventListener("click", (event) => { if (event.target === modal) settle(false); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !modal.classList.contains("hidden")) settle(false); });
    return modal;
  }

  function settle(accepted) {
    const modal = ensureModal();
    modal.classList.add("hidden");
    const current = pending;
    pending = null;
    if (current) current.resolve(accepted);
  }

  function ask(details) {
    if (pending) return Promise.resolve(false);
    const modal = ensureModal();
    const accept = modal.querySelector("#analysisConfirmAccept");
    modal.querySelector("#analysisConfirmTitle").textContent = details.title;
    accept.textContent = details.danger ? "Да, удалить" : "Подтвердить";
    accept.classList.toggle("analysis-confirm-danger", details.danger);
    modal.querySelector("#analysisConfirmChanges").innerHTML = details.changes.length
      ? details.changes.map(([label, value]) => `<div class="analysis-confirm-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("")
      : '<div class="analysis-confirm-row"><span>Действие</span><strong>Изменение параметра</strong></div>';
    modal.classList.remove("hidden");
    accept.focus();
    return new Promise((resolve) => { pending = { resolve }; });
  }

  function askForRequest(input, init) {
    return ask(describe(input, init));
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-toggle]");
    if (!button || clickBypass) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const key = button.dataset.toggle || "";
    const currentlyOn = button.classList.contains("on") || button.textContent.includes("ON");
    const accepted = await ask({
      title: "Подтвердить переключение",
      danger: false,
      changes: [["Параметр", key], ["Selected", currentlyOn ? "ON → OFF" : "OFF → ON"]],
    });
    if (!accepted) return;
    preconfirmedMutation = true;
    clickBypass = true;
    button.click();
    clickBypass = false;
  }, true);

  window.fetch = async function confirmedFetch(input, init = {}) {
    if (!isAnalysisMutation(input, init)) return nativeFetch(input, init);
    if (preconfirmedMutation) {
      preconfirmedMutation = false;
      return nativeFetch(input, init);
    }
    const accepted = await askForRequest(input, init);
    if (!accepted) throw new DOMException("Изменение отменено пользователем", "AbortError");
    return nativeFetch(input, init);
  };
})();
