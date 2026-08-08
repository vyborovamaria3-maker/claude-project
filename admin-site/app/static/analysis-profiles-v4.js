(() => {
  const LABELS = { wallet: "Wallet / Creator", token: "Token", telegram: "Telegram", x: "X / Twitter" };
  const TYPES = ["number", "percent", "currency", "duration", "boolean", "score", "text", "timestamp", "object"];
  const SCALES = ["raw", "ratio", "percent100", "seconds", "milliseconds", "hours", "days", "millions"];
  let currentDomain = "wallet";
  let open = false;
  let rows = [];
  let counts = {};
  let selectedContract = "";
  let showHidden = false;
  let editingKey = null;

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  async function api(path, options = {}) {
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
    const type = response.headers.get("content-type") || "";
    return type.includes("application/json") ? response.json() : response.text();
  }

  function toastSafe(message, error = false) {
    if (typeof toast === "function") toast(message, error);
  }

  function stateBadge(row) {
    const labels = { active: "ACTIVE", available: "AVAILABLE", derived: "DERIVED", legacy: "LEGACY" };
    return `<span class="analysis-state ${esc(row.runtime_state)}">${labels[row.runtime_state] || esc(row.runtime_state)}</span>`;
  }

  function typeLabel(row) {
    const names = { number: "number", percent: "%", currency: "USD", duration: "time", boolean: "bool", score: "score", text: "text", timestamp: "date", object: "JSON" };
    const base = names[row.type] || row.type;
    return row.scale && !["raw", "percent100"].includes(row.scale) ? `${base} · ${row.scale}` : base;
  }

  function ruleBadge(row) {
    if (!row.rule_capable) return '<span class="analysis-rule display-only">DISPLAY ONLY</span>';
    return `<span class="analysis-rule ${row.rule_active ? "active" : ""}">${row.rule_active ? "RULE ACTIVE" : "NO RULE"}</span>`;
  }

  function visibleRows() {
    return rows.filter((row) => showHidden || !row.hidden);
  }

  function contracts() {
    return [...new Set(rows.filter((row) => row.rule_capable && !row.hidden).map((row) => row.contract))].sort();
  }

  function recalcCount() {
    const domainRows = rows.filter((row) => row.domain === currentDomain);
    counts[currentDomain] = {
      total: domainRows.length,
      selected: domainRows.filter((row) => row.enabled && !row.hidden).length,
      rules: domainRows.filter((row) => row.rule_active && !row.hidden).length,
      active: domainRows.filter((row) => row.runtime_state === "active").length,
      available: domainRows.filter((row) => row.runtime_state === "available").length,
      derived: domainRows.filter((row) => row.runtime_state === "derived").length,
      legacy: domainRows.filter((row) => row.runtime_state === "legacy").length,
      hidden: domainRows.filter((row) => row.hidden).length,
    };
  }

  function rowByKey(key) { return rows.find((row) => row.key === key); }

  function replaceRow(next) {
    const index = rows.findIndex((row) => row.key === next.key);
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    recalcCount();
    renderShell();
  }

  function removeRow(key) {
    rows = rows.filter((row) => row.key !== key);
    recalcCount();
    renderShell();
  }

  function renderTable() {
    const tableRows = visibleRows();
    if (!tableRows.length) return '<div class="empty">Параметры не найдены.</div>';
    return `<div class="table-shell analysis-table-shell"><table class="analysis-table"><thead><tr>
      <th>Selected</th><th>Runtime</th><th>Rule</th><th>Параметр</th><th>Поле</th><th>Тип</th><th>Порог</th><th>Contract</th><th>Источник</th><th></th>
    </tr></thead><tbody>${tableRows.map((row) => `<tr class="analysis-row-clickable ${row.enabled ? "" : "analysis-disabled"} ${row.hidden ? "analysis-row-hidden" : ""}" data-row="${esc(row.key)}">
      <td><button class="analysis-switch ${row.enabled ? "on" : ""}" data-toggle="${esc(row.key)}" ${row.runtime_state === "legacy" || row.hidden ? "disabled" : ""} aria-label="toggle ${esc(row.key)}"><span></span>${row.enabled ? "ON" : "OFF"}</button></td>
      <td>${stateBadge(row)}</td>
      <td>${ruleBadge(row)}</td>
      <td><strong>${esc(row.label)}</strong><small>${esc(row.description || "")}</small><code>${esc(row.key)}</code></td>
      <td><code>${esc(row.source)}</code></td>
      <td><span class="analysis-type">${esc(typeLabel(row))}</span></td>
      <td><span>${esc(row.threshold || "—")}</span></td>
      <td><span class="analysis-contract">${esc(row.contract)}</span></td>
      <td><span class="analysis-origin ${row.custom ? "custom" : "project"}">${row.custom ? "custom" : esc(row.project_ref || "project")}</span></td>
      <td><button class="small-btn" data-edit="${esc(row.key)}">${row.hidden ? "Восстановить" : "Изменить"}</button></td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function renderShell() {
    const count = counts[currentDomain] || {};
    const content = $("#content");
    if (!content) return;
    const availableContracts = contracts();
    if (!selectedContract || !availableContracts.includes(selectedContract)) selectedContract = availableContracts[0] || "";
    $("#viewTitle").textContent = "Параметры анализа";
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    $("#analysisProfilesNav")?.classList.add("active");
    content.innerHTML = `
      <div class="cards analysis-summary">
        <article class="card"><div class="metric-label">Параметров</div><div class="metric-value">${Number(count.total || 0)}</div><div class="metric-sub">в каталоге</div></article>
        <article class="card"><div class="metric-label">Selected</div><div class="metric-value">${Number(count.selected || 0)}</div><div class="metric-sub">включены</div></article>
        <article class="card"><div class="metric-label">Rules</div><div class="metric-value">${Number(count.rules || 0)}</div><div class="metric-sub">активные thresholds</div></article>
        <article class="card"><div class="metric-label">Hidden</div><div class="metric-value">${Number(count.hidden || 0)}</div><div class="metric-sub">убраны из профиля</div></article>
        <article class="card"><div class="metric-label">ACTIVE</div><div class="metric-value">${Number(count.active || 0)}</div><div class="metric-sub">pipeline</div></article>
        <article class="card"><div class="metric-label">LEGACY</div><div class="metric-value">${Number(count.legacy || 0)}</div><div class="metric-sub">история</div></article>
      </div>
      <section class="section full">
        <div class="section-head"><div><h3>Live Analysis Editor</h3><p>Нажмите на строку: изменения применяются без перезагрузки страницы. System schema защищена; custom-поля редактируются полностью.</p></div></div>
        <div class="analysis-tabs">${Object.entries(LABELS).map(([domain, label]) => `<button class="analysis-tab ${domain === currentDomain ? "active" : ""}" data-domain="${domain}">${esc(label)}</button>`).join("")}</div>
        <div class="analysis-editor-toolbar"><div class="analysis-editor-toolbar-group"><button id="analysisHiddenToggle" class="secondary analysis-hidden-toggle ${showHidden ? "active" : ""}">${showHidden ? "Скрыть удалённые" : `Показать удалённые (${Number(count.hidden || 0)})`}</button></div><div class="analysis-editor-toolbar-group"><span class="muted">Клик по параметру → редактор</span></div></div>
        ${renderTable()}
      </section>
      <div class="section-grid analysis-bottom-grid">
        <section class="section">
          <div class="section-head"><div><h3>Добавить параметр</h3><p>Custom-параметр можно потом полностью редактировать и удалить.</p></div></div>
          <div class="analysis-form">
            <input id="analysisKey" placeholder="custom_metric">
            <input id="analysisLabel" placeholder="Название">
            <input id="analysisSource" placeholder="metrics.customField">
            <select id="analysisType">${TYPES.filter((t) => t !== "object").map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
            <select id="analysisScale">${SCALES.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
            <input id="analysisThreshold" placeholder=">= 20% / <= $100k / true">
            <input id="analysisDescription" placeholder="Описание">
            <button id="analysisCreate" class="primary">Добавить</button>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><div><h3>Backtest профиля</h3><p>Backtest выполняется по выбранному data contract.</p></div></div>
          <select id="analysisContract" class="analysis-contract-select">${availableContracts.map((name) => `<option value="${esc(name)}" ${name === selectedContract ? "selected" : ""}>${esc(name)}</option>`).join("")}</select>
          <textarea id="analysisBacktestInput" class="analysis-json-input" spellcheck="false" placeholder='[{"migrationRate":0.42,"riskScore":23}]'></textarea>
          <div class="analysis-backtest-actions"><button id="analysisRunBacktest" class="primary">Запустить backtest</button><span id="analysisBacktestHint" class="muted"></span></div>
          <pre id="analysisBacktestResult" class="pre analysis-backtest-result">Результат появится здесь.</pre>
        </section>
      </div>
      ${renderEditorModal()}`;
    bind();
  }

  function renderEditorModal() {
    const row = editingKey ? rowByKey(editingKey) : null;
    if (!row) return '<div id="analysisEditorModal" class="analysis-editor-modal hidden"></div>';
    const custom = Boolean(row.custom);
    const immutable = !custom;
    const disabledRule = !row.rule_capable || row.runtime_state === "legacy" || row.hidden;
    return `<div id="analysisEditorModal" class="analysis-editor-modal">
      <section class="analysis-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="analysisEditorTitle">
        <div class="analysis-editor-dialog-head"><div><h3 id="analysisEditorTitle">${esc(row.label)}</h3><p>${custom ? "Custom parameter — все поля можно менять" : "System parameter — source/type/contract защищены"}</p></div><button id="analysisEditorClose" class="ghost">Закрыть</button></div>
        <div class="analysis-editor-dialog-body">
          ${immutable ? '<div class="analysis-editor-system-note">Системный параметр можно включить/выключить, изменить threshold или убрать из профиля. Source path, тип и contract не редактируются, чтобы не сломать соответствие реальному pipeline.</div>' : ''}
          <div class="analysis-editor-grid">
            <label class="analysis-editor-field"><span>Selected</span><select id="editorEnabled" ${row.runtime_state === "legacy" || row.hidden ? "disabled" : ""}><option value="true" ${row.enabled ? "selected" : ""}>ON</option><option value="false" ${!row.enabled ? "selected" : ""}>OFF</option></select></label>
            <label class="analysis-editor-field"><span>Threshold</span><input id="editorThreshold" value="${esc(row.threshold || "")}" placeholder=">= 20%" ${disabledRule ? "disabled" : ""}></label>
            ${custom ? `<label class="analysis-editor-field"><span>Название</span><input id="editorLabel" value="${esc(row.label)}"></label><label class="analysis-editor-field"><span>Source path</span><input id="editorSource" value="${esc(row.source)}"></label><label class="analysis-editor-field"><span>Тип</span><select id="editorType">${TYPES.map((t) => `<option value="${t}" ${row.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label><label class="analysis-editor-field"><span>Scale</span><select id="editorScale">${SCALES.map((s) => `<option value="${s}" ${row.scale === s ? "selected" : ""}>${s}</option>`).join("")}</select></label><label class="analysis-editor-field full"><span>Описание</span><textarea id="editorDescription">${esc(row.description || "")}</textarea></label>` : `<div class="analysis-editor-field"><span>Source path</span><div class="analysis-editor-readonly mono">${esc(row.source)}</div></div><div class="analysis-editor-field"><span>Тип / scale</span><div class="analysis-editor-readonly">${esc(typeLabel(row))}</div></div><div class="analysis-editor-field full"><span>Contract</span><div class="analysis-editor-readonly mono">${esc(row.contract)}</div></div>`}
          </div>
          <div id="analysisEditorStatus" class="analysis-editor-status" aria-live="polite"></div>
        </div>
        <div class="analysis-editor-actions">
          ${row.hidden ? '<button id="analysisEditorRestore" class="secondary analysis-editor-restore">Восстановить</button>' : `<button id="analysisEditorDelete" class="secondary analysis-editor-danger">${custom ? "Удалить полностью" : "Убрать параметр"}</button>`}
          ${row.hidden ? "" : '<button id="analysisEditorSave" class="primary">Сохранить</button>'}
        </div>
      </section>
    </div>`;
  }

  async function load() {
    if (!open) return;
    try {
      const data = await api(`/api/analysis-profiles?domain=${encodeURIComponent(currentDomain)}`);
      rows = data.rows || [];
      counts = data.counts || {};
      recalcCount();
      renderShell();
    } catch (error) {
      $("#content").innerHTML = `<div class="empty"><strong>Не удалось загрузить профили</strong><p>${esc(error.message)}</p></div>`;
      toastSafe(error.message, true);
    }
  }

  async function quickToggle(key) {
    const row = rowByKey(key); if (!row || row.hidden) return;
    const old = { ...row };
    row.enabled = !row.enabled;
    row.rule_active = Boolean(row.enabled && row.threshold && row.rule_capable);
    recalcCount(); renderShell();
    try {
      const next = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ enabled: row.enabled, threshold: row.threshold || "" }) });
      replaceRow(next); toastSafe(`${next.label}: ${next.enabled ? "ON" : "OFF"}`);
    } catch (error) {
      replaceRow(old); toastSafe(error.message, true);
    }
  }

  async function saveEditor() {
    const row = rowByKey(editingKey); if (!row) return;
    const status = $("#analysisEditorStatus");
    const payload = { enabled: $("#editorEnabled")?.value === "true", threshold: $("#editorThreshold")?.value.trim() || "" };
    if (row.custom) Object.assign(payload, { label: $("#editorLabel").value.trim(), source: $("#editorSource").value.trim(), value_type: $("#editorType").value, scale: $("#editorScale").value, description: $("#editorDescription").value.trim() });
    status.textContent = "Сохранение…"; status.classList.remove("error");
    try {
      const next = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/${encodeURIComponent(row.key)}/editor`, { method: "PATCH", body: JSON.stringify(payload) });
      replaceRow(next); editingKey = next.key; toastSafe("Изменения применены");
    } catch (error) { status.textContent = error.message; status.classList.add("error"); toastSafe(error.message, true); }
  }

  async function deleteEditor() {
    const row = rowByKey(editingKey); if (!row) return;
    const status = $("#analysisEditorStatus"); status.textContent = row.custom ? "Удаление…" : "Убираю из профиля…";
    try {
      const result = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/${encodeURIComponent(row.key)}/entry`, { method: "DELETE" });
      if (result.custom) { editingKey = null; removeRow(row.key); toastSafe("Custom-параметр удалён"); }
      else { replaceRow(result.row); editingKey = null; renderShell(); toastSafe("Системный параметр убран. Его можно восстановить."); }
    } catch (error) { status.textContent = error.message; status.classList.add("error"); toastSafe(error.message, true); }
  }

  async function restoreEditor() {
    const row = rowByKey(editingKey); if (!row) return;
    try {
      const next = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/${encodeURIComponent(row.key)}/restore`, { method: "POST" });
      replaceRow(next); editingKey = next.key; toastSafe("Параметр восстановлен");
    } catch (error) { toastSafe(error.message, true); }
  }

  function bind() {
    document.querySelectorAll("[data-domain]").forEach((button) => button.addEventListener("click", async () => { currentDomain = button.dataset.domain; selectedContract = ""; editingKey = null; await load(); }));
    $("#analysisHiddenToggle")?.addEventListener("click", () => { showHidden = !showHidden; renderShell(); });
    document.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); quickToggle(button.dataset.toggle); }));
    document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); editingKey = button.dataset.edit; renderShell(); }));
    document.querySelectorAll("[data-row]").forEach((row) => row.addEventListener("click", () => { editingKey = row.dataset.row; renderShell(); }));
    $("#analysisEditorClose")?.addEventListener("click", () => { editingKey = null; renderShell(); });
    $("#analysisEditorModal")?.addEventListener("click", (event) => { if (event.target.id === "analysisEditorModal") { editingKey = null; renderShell(); } });
    $("#analysisEditorSave")?.addEventListener("click", saveEditor);
    $("#analysisEditorDelete")?.addEventListener("click", deleteEditor);
    $("#analysisEditorRestore")?.addEventListener("click", restoreEditor);
    $("#analysisCreate")?.addEventListener("click", async () => {
      const payload = { key: $("#analysisKey").value.trim(), label: $("#analysisLabel").value.trim(), source: $("#analysisSource").value.trim(), value_type: $("#analysisType").value, scale: $("#analysisScale").value, threshold: $("#analysisThreshold").value.trim(), enabled: true, description: $("#analysisDescription").value.trim() };
      try { const next = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}`, { method: "POST", body: JSON.stringify(payload) }); rows.push(next); recalcCount(); selectedContract = `${currentDomain}.custom`; renderShell(); toastSafe("Параметр добавлен"); }
      catch (error) { toastSafe(error.message, true); }
    });
    $("#analysisContract")?.addEventListener("change", (event) => { selectedContract = event.target.value; });
    $("#analysisRunBacktest")?.addEventListener("click", async () => {
      const out = $("#analysisBacktestResult");
      try {
        const parsed = JSON.parse($("#analysisBacktestInput").value || "[]");
        if (!Array.isArray(parsed)) throw new Error("Нужен JSON-массив записей");
        selectedContract = $("#analysisContract")?.value || ""; out.textContent = "Backtest…";
        const result = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/backtest`, { method: "POST", body: JSON.stringify({ records: parsed, contract: selectedContract || null }) });
        out.textContent = JSON.stringify(result, null, 2);
        $("#analysisBacktestHint").textContent = result.pass_rate == null ? `Contract ${result.contract || "—"}: нет полных записей` : `Contract ${result.contract}: pass ${(result.pass_rate * 100).toFixed(1)}%, coverage ${((result.coverage || 0) * 100).toFixed(1)}%`;
      } catch (error) { out.textContent = error.message; toastSafe(error.message, true); }
    });
  }

  async function activate() { open = true; await load(); }
  function deactivate() { open = false; editingKey = null; }

  document.addEventListener("DOMContentLoaded", () => {
    $("#analysisProfilesNav")?.addEventListener("click", activate);
    $("#navigation")?.addEventListener("click", (event) => { if (event.target.closest("[data-view]")) deactivate(); }, true);
    $("#refreshButton")?.addEventListener("click", (event) => { if (open) { event.stopImmediatePropagation(); load(); } }, true);
  });

  window.AdminAnalysisProfiles = { activate, deactivate, reload: load };
})();
