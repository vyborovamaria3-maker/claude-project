(() => {
  const LABELS = { wallet: "Wallet / Creator", token: "Token", telegram: "Telegram", x: "X / Twitter" };
  let currentDomain = "wallet";
  let open = false;
  let rows = [];
  let selectedContract = "";

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

  function contracts() {
    return [...new Set(rows.filter((row) => row.rule_capable).map((row) => row.contract))].sort();
  }

  function renderTable() {
    if (!rows.length) return '<div class="empty">Параметры не найдены.</div>';
    return `<div class="table-shell analysis-table-shell"><table class="analysis-table"><thead><tr>
      <th>Selected</th><th>Runtime</th><th>Rule</th><th>Параметр</th><th>Поле</th><th>Тип</th><th>Порог</th><th>Contract</th><th>Источник</th><th></th>
    </tr></thead><tbody>${rows.map((row) => `<tr class="${row.enabled ? "" : "analysis-disabled"}">
      <td><button class="analysis-switch ${row.enabled ? "on" : ""}" data-toggle="${esc(row.key)}" ${row.runtime_state === "legacy" ? "disabled" : ""} aria-label="toggle ${esc(row.key)}"><span></span>${row.enabled ? "ON" : "OFF"}</button></td>
      <td>${stateBadge(row)}</td>
      <td>${ruleBadge(row)}</td>
      <td><strong>${esc(row.label)}</strong><small>${esc(row.description || "")}</small><code>${esc(row.key)}</code></td>
      <td><code>${esc(row.source)}</code></td>
      <td><span class="analysis-type">${esc(typeLabel(row))}</span></td>
      <td><div class="analysis-threshold-edit"><input data-threshold="${esc(row.key)}" value="${esc(row.threshold || "")}" placeholder="например >= 20%" ${!row.rule_capable || row.runtime_state === "legacy" ? "disabled" : ""}><button class="small-btn" data-save="${esc(row.key)}" ${!row.rule_capable || row.runtime_state === "legacy" ? "disabled" : ""}>Сохранить</button></div></td>
      <td><span class="analysis-contract">${esc(row.contract)}</span></td>
      <td><span class="analysis-origin ${row.custom ? "custom" : "project"}">${row.custom ? "custom" : esc(row.project_ref || "project")}</span></td>
      <td>${row.custom ? `<button class="small-btn danger-btn" data-delete="${esc(row.key)}">Удалить</button>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function renderShell(data) {
    const count = data.counts?.[currentDomain] || {};
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
        <article class="card"><div class="metric-label">Selected</div><div class="metric-value">${Number(count.selected || 0)}</div><div class="metric-sub">включены в профиль</div></article>
        <article class="card"><div class="metric-label">Rules</div><div class="metric-value">${Number(count.rules || 0)}</div><div class="metric-sub">имеют threshold</div></article>
        <article class="card"><div class="metric-label">ACTIVE</div><div class="metric-value">${Number(count.active || 0)}</div><div class="metric-sub">выход текущего pipeline</div></article>
        <article class="card"><div class="metric-label">DERIVED</div><div class="metric-value">${Number(count.derived || 0)}</div><div class="metric-sub">вычисляются из полей</div></article>
        <article class="card"><div class="metric-label">LEGACY</div><div class="metric-value">${Number(count.legacy || 0)}</div><div class="metric-sub">только история</div></article>
      </div>
      <section class="section full">
        <div class="section-head"><div><h3>Analysis Profiles</h3><p>Selected означает, что параметр входит в профиль. RULE ACTIVE означает, что у него есть валидный threshold и он реально участвует в backtest.</p></div></div>
        <div class="analysis-tabs">${Object.entries(LABELS).map(([domain, label]) => `<button class="analysis-tab ${domain === currentDomain ? "active" : ""}" data-domain="${domain}">${esc(label)}</button>`).join("")}</div>
        ${renderTable()}
      </section>
      <div class="section-grid analysis-bottom-grid">
        <section class="section">
          <div class="section-head"><div><h3>Добавить параметр</h3><p>Custom-параметры получают отдельный contract ${esc(currentDomain)}.custom.</p></div></div>
          <div class="analysis-form">
            <input id="analysisKey" placeholder="custom_metric">
            <input id="analysisLabel" placeholder="Название">
            <input id="analysisSource" placeholder="metrics.customField">
            <select id="analysisType"><option value="number">Число</option><option value="percent">Процент</option><option value="currency">USD</option><option value="duration">Время</option><option value="boolean">Да/нет</option><option value="score">Score</option><option value="text">Текст</option><option value="timestamp">Дата</option></select>
            <select id="analysisScale"><option value="raw">raw</option><option value="ratio">ratio 0..1</option><option value="percent100">percent 0..100</option><option value="seconds">seconds</option><option value="milliseconds">milliseconds</option><option value="hours">hours</option><option value="days">days</option><option value="millions">millions</option></select>
            <input id="analysisThreshold" placeholder=">= 20% / <= $100k / true">
            <input id="analysisDescription" placeholder="Описание">
            <button id="analysisCreate" class="primary">Добавить</button>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><div><h3>Backtest профиля</h3><p>Backtest выполняется только по одному совместимому data contract.</p></div></div>
          <select id="analysisContract" class="analysis-contract-select">${availableContracts.map((name) => `<option value="${esc(name)}" ${name === selectedContract ? "selected" : ""}>${esc(name)}</option>`).join("")}</select>
          <p class="analysis-contract-help">Поля из другого API/датасета не будут ошибочно считаться missing.</p>
          <textarea id="analysisBacktestInput" class="analysis-json-input" spellcheck="false" placeholder='[{"migrationRate":0.42,"riskScore":23}]'></textarea>
          <div class="analysis-backtest-actions"><button id="analysisRunBacktest" class="primary">Запустить backtest</button><span id="analysisBacktestHint" class="muted"></span></div>
          <pre id="analysisBacktestResult" class="pre analysis-backtest-result">Результат появится здесь.</pre>
        </section>
      </div>`;
    bind();
  }

  async function load() {
    if (!open) return;
    try {
      const data = await api(`/api/analysis-profiles?domain=${encodeURIComponent(currentDomain)}`);
      rows = data.rows || [];
      renderShell(data);
    } catch (error) {
      $("#content").innerHTML = `<div class="empty"><strong>Не удалось загрузить профили</strong><p>${esc(error.message)}</p></div>`;
      toastSafe(error.message, true);
    }
  }

  function rowByKey(key) { return rows.find((row) => row.key === key); }

  function bind() {
    document.querySelectorAll("[data-domain]").forEach((button) => button.addEventListener("click", async () => {
      currentDomain = button.dataset.domain;
      selectedContract = "";
      await load();
    }));
    document.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", async () => {
      const row = rowByKey(button.dataset.toggle); if (!row) return;
      const input = document.querySelector(`[data-threshold="${CSS.escape(row.key)}"]`);
      try {
        await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/${encodeURIComponent(row.key)}`, { method: "PUT", body: JSON.stringify({ enabled: !row.enabled, threshold: input?.value || "" }) });
        toastSafe(`${row.label}: ${row.enabled ? "OFF" : "ON"}`); await load();
      } catch (error) { toastSafe(error.message, true); }
    }));
    document.querySelectorAll("[data-save]").forEach((button) => button.addEventListener("click", async () => {
      const row = rowByKey(button.dataset.save); if (!row) return;
      const input = document.querySelector(`[data-threshold="${CSS.escape(row.key)}"]`);
      try {
        await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/${encodeURIComponent(row.key)}`, { method: "PUT", body: JSON.stringify({ enabled: row.enabled, threshold: input?.value || "" }) });
        toastSafe("Порог сохранён"); await load();
      } catch (error) { toastSafe(error.message, true); }
    }));
    document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
      try { await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/${encodeURIComponent(button.dataset.delete)}`, { method: "DELETE" }); toastSafe("Параметр удалён"); await load(); }
      catch (error) { toastSafe(error.message, true); }
    }));
    $("#analysisCreate")?.addEventListener("click", async () => {
      const payload = { key: $("#analysisKey").value.trim(), label: $("#analysisLabel").value.trim(), source: $("#analysisSource").value.trim(), value_type: $("#analysisType").value, scale: $("#analysisScale").value, threshold: $("#analysisThreshold").value.trim(), enabled: true, description: $("#analysisDescription").value.trim() };
      try { await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}`, { method: "POST", body: JSON.stringify(payload) }); toastSafe("Параметр добавлен"); selectedContract = `${currentDomain}.custom`; await load(); }
      catch (error) { toastSafe(error.message, true); }
    });
    $("#analysisContract")?.addEventListener("change", (event) => { selectedContract = event.target.value; });
    $("#analysisRunBacktest")?.addEventListener("click", async () => {
      const out = $("#analysisBacktestResult");
      try {
        const parsed = JSON.parse($("#analysisBacktestInput").value || "[]");
        if (!Array.isArray(parsed)) throw new Error("Нужен JSON-массив записей");
        selectedContract = $("#analysisContract")?.value || "";
        out.textContent = "Backtest…";
        const result = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/backtest`, { method: "POST", body: JSON.stringify({ records: parsed, contract: selectedContract || null }) });
        out.textContent = JSON.stringify(result, null, 2);
        $("#analysisBacktestHint").textContent = result.pass_rate == null ? `Contract ${result.contract || "—"}: нет полных записей` : `Contract ${result.contract}: pass ${(result.pass_rate * 100).toFixed(1)}%, coverage ${((result.coverage || 0) * 100).toFixed(1)}%`;
      } catch (error) { out.textContent = error.message; toastSafe(error.message, true); }
    });
  }

  async function activate() { open = true; await load(); }
  function deactivate() { open = false; }

  document.addEventListener("DOMContentLoaded", () => {
    $("#analysisProfilesNav")?.addEventListener("click", activate);
    $("#navigation")?.addEventListener("click", (event) => { if (event.target.closest("[data-view]")) deactivate(); }, true);
    $("#refreshButton")?.addEventListener("click", (event) => { if (open) { event.stopImmediatePropagation(); load(); } }, true);
  });

  window.AdminAnalysisProfiles = { activate, deactivate, reload: load };
})();
