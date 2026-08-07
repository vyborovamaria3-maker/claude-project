(() => {
  const LABELS = { wallet: "Wallet / Creator", token: "Token", telegram: "Telegram", x: "X / Twitter" };
  let currentDomain = "wallet";
  let open = false;
  let rows = [];

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
    const labels = { active: "ACTIVE", available: "AVAILABLE", legacy: "LEGACY" };
    return `<span class="analysis-state ${esc(row.runtime_state)}">${labels[row.runtime_state] || esc(row.runtime_state)}</span>`;
  }

  function typeLabel(row) {
    const names = { number: "number", percent: "%", currency: "USD", duration: "time", boolean: "bool", score: "score", text: "text", timestamp: "date" };
    const base = names[row.type] || row.type;
    return row.scale && !["raw", "percent100"].includes(row.scale) ? `${base} · ${row.scale}` : base;
  }

  function renderTable() {
    if (!rows.length) return '<div class="empty">Параметры не найдены.</div>';
    return `<div class="table-shell analysis-table-shell"><table class="analysis-table"><thead><tr>
      <th>ON</th><th>Runtime</th><th>Параметр</th><th>Поле</th><th>Тип</th><th>Порог</th><th>Источник</th><th></th>
    </tr></thead><tbody>${rows.map((row) => `<tr class="${row.enabled ? "" : "analysis-disabled"}">
      <td><button class="analysis-switch ${row.enabled ? "on" : ""}" data-toggle="${esc(row.key)}" ${row.runtime_state === "legacy" ? "disabled" : ""} aria-label="toggle ${esc(row.key)}"><span></span>${row.enabled ? "ON" : "OFF"}</button></td>
      <td>${stateBadge(row)}</td>
      <td><strong>${esc(row.label)}</strong><small>${esc(row.description || "")}</small><code>${esc(row.key)}</code></td>
      <td><code>${esc(row.source)}</code></td>
      <td><span class="analysis-type">${esc(typeLabel(row))}</span></td>
      <td><div class="analysis-threshold-edit"><input data-threshold="${esc(row.key)}" value="${esc(row.threshold || "")}" placeholder="например >= 20%"><button class="small-btn" data-save="${esc(row.key)}" ${row.runtime_state === "legacy" ? "disabled" : ""}>Сохранить</button></div></td>
      <td><span class="analysis-origin ${row.custom ? "custom" : "project"}">${row.custom ? "custom" : esc(row.project_ref || "project")}</span></td>
      <td>${row.custom ? `<button class="small-btn danger-btn" data-delete="${esc(row.key)}">Удалить</button>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function renderShell(data) {
    const count = data.counts?.[currentDomain] || {};
    const content = $("#content");
    if (!content) return;
    $("#viewTitle").textContent = "Параметры анализа";
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    $("#analysisProfilesNav")?.classList.add("active");
    content.innerHTML = `
      <div class="cards analysis-summary">
        <article class="card"><div class="metric-label">Параметров</div><div class="metric-value">${Number(count.total || 0)}</div><div class="metric-sub">в профиле ${esc(LABELS[currentDomain])}</div></article>
        <article class="card"><div class="metric-label">Включено</div><div class="metric-value">${Number(count.enabled || 0)}</div><div class="metric-sub">участвуют в backtest</div></article>
        <article class="card"><div class="metric-label">ACTIVE</div><div class="metric-value">${Number(count.active || 0)}</div><div class="metric-sub">текущий pipeline</div></article>
        <article class="card"><div class="metric-label">AVAILABLE</div><div class="metric-value">${Number(count.available || 0)}</div><div class="metric-sub">поле существует</div></article>
        <article class="card"><div class="metric-label">LEGACY</div><div class="metric-value">${Number(count.legacy || 0)}</div><div class="metric-sub">историческое поле</div></article>
      </div>
      <section class="section full">
        <div class="section-head"><div><h3>Analysis Profiles</h3><p>ACTIVE — используется текущим pipeline; AVAILABLE — поле доступно для правил; LEGACY — оставлено для истории и не может быть включено.</p></div></div>
        <div class="analysis-tabs">${Object.entries(LABELS).map(([domain, label]) => `<button class="analysis-tab ${domain === currentDomain ? "active" : ""}" data-domain="${domain}">${esc(label)}</button>`).join("")}</div>
        ${renderTable()}
      </section>
      <div class="section-grid analysis-bottom-grid">
        <section class="section">
          <div class="section-head"><div><h3>Добавить параметр</h3><p>Сервер проверит key, source path, тип, scale и threshold.</p></div></div>
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
          <div class="section-head"><div><h3>Backtest профиля</h3><p>Вставь JSON-массив исторических записей. Missing не считается pass или fail.</p></div></div>
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
      try { await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}`, { method: "POST", body: JSON.stringify(payload) }); toastSafe("Параметр добавлен"); await load(); }
      catch (error) { toastSafe(error.message, true); }
    });
    $("#analysisRunBacktest")?.addEventListener("click", async () => {
      const out = $("#analysisBacktestResult");
      try {
        const parsed = JSON.parse($("#analysisBacktestInput").value || "[]");
        if (!Array.isArray(parsed)) throw new Error("Нужен JSON-массив записей");
        out.textContent = "Backtest…";
        const result = await api(`/api/analysis-profiles/${encodeURIComponent(currentDomain)}/backtest`, { method: "POST", body: JSON.stringify({ records: parsed }) });
        out.textContent = JSON.stringify(result, null, 2);
        $("#analysisBacktestHint").textContent = result.pass_rate == null ? "Нет оценённых записей" : `Pass rate ${(result.pass_rate * 100).toFixed(1)}%`;
      } catch (error) { out.textContent = error.message; toastSafe(error.message, true); }
    });
  }

  async function activate() {
    open = true;
    await load();
  }

  function deactivate() { open = false; }

  document.addEventListener("DOMContentLoaded", () => {
    $("#analysisProfilesNav")?.addEventListener("click", activate);
    $("#navigation")?.addEventListener("click", (event) => { if (event.target.closest("[data-view]")) deactivate(); }, true);
    $("#refreshButton")?.addEventListener("click", (event) => { if (open) { event.stopImmediatePropagation(); load(); } }, true);
  });

  window.AdminAnalysisProfiles = { activate, deactivate, reload: load };
})();
