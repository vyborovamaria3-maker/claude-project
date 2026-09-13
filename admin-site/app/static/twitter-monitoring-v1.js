(() => {
  let active = false;
  let snapshot = null;
  let tableName = "twitter_accounts";
  let tablePage = 1;
  let tableSearch = "";

  const settingFields = [
    "enabled", "query_limit", "process_limit", "batch_size", "max_depth",
    "min_relevance", "network_mode", "network_limit", "lease_seconds", "rescore_limit",
    "public_enabled", "public_dexscreener_latest", "public_dexscreener_boosts",
    "public_db_solana_tokens", "public_cmc_limit", "public_rescore_limit",
  ];

  const boolFields = new Set([
    "enabled", "public_enabled", "public_dexscreener_latest", "public_dexscreener_boosts",
  ]);

  const labels = {
    enabled: "X/API цикл включён",
    query_limit: "X results / query",
    process_limit: "Кандидатов / цикл",
    batch_size: "Claim batch",
    max_depth: "Глубина сети",
    min_relevance: "Мин. relevance",
    network_mode: "Расширение сети",
    network_limit: "Аккаунтов сети / candidate",
    lease_seconds: "Lease worker, сек",
    rescore_limit: "Rescore / X цикл",
    public_enabled: "Public discovery включён",
    public_dexscreener_latest: "DEX Screener latest profiles",
    public_dexscreener_boosts: "DEX Screener boosts",
    public_db_solana_tokens: "DB Solana tokens / run",
    public_cmc_limit: "CoinMarketCap / run",
    public_rescore_limit: "Rescore / public run",
  };

  function setActive(value) {
    active = value;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    if (value) document.querySelector("#twitterMonitoringNav")?.classList.add("active");
  }

  function inputFor(name, value) {
    const label = escapeHtml(labels[name] || name);
    if (boolFields.has(name)) {
      return `<label class="twitter-toggle"><input id="tw-${name}" type="checkbox" ${value ? "checked" : ""}/><span>${label}</span></label>`;
    }
    if (name === "network_mode") {
      return `<label>${label}<select id="tw-${name}">${["none", "following", "followers", "both"].map((item) => `<option value="${item}" ${item === value ? "selected" : ""}>${item}</option>`).join("")}</select></label>`;
    }
    const step = name === "min_relevance" ? "0.1" : "1";
    return `<label>${label}<input id="tw-${name}" type="number" step="${step}" value="${escapeHtml(value)}"/></label>`;
  }

  function readSettings() {
    const values = {};
    for (const name of settingFields) {
      const element = document.querySelector(`#tw-${name}`);
      if (!element) continue;
      if (boolFields.has(name)) values[name] = Boolean(element.checked);
      else if (name === "network_mode") values[name] = element.value;
      else values[name] = Number(element.value);
    }
    return values;
  }

  async function loadTable() {
    if (!snapshot?.source_id || !tableName) return null;
    const params = new URLSearchParams({
      page: String(tablePage),
      page_size: "50",
      search: tableSearch,
    });
    return api(`/api/sources/${encodeURIComponent(snapshot.source_id)}/tables/${encodeURIComponent(tableName)}?${params}`);
  }

  function displayRunStatus(run) {
    return run?.stale ? "stale" : (run?.status || "unknown");
  }

  function runStatusClass(status) {
    if (status === "success") return "ok";
    if (status === "running") return "warn";
    if (status === "degraded") return "warn";
    if (status === "disabled" || status === "cancelled") return "warn";
    return "bad";
  }

  async function renderTwitterMonitoring() {
    setActive(true);
    document.querySelector("#viewTitle").textContent = "X / Twitter — мониторинг";
    loading();
    try {
      snapshot = await api("/api/twitter-monitoring");
      if (!snapshot.tables.includes(tableName)) tableName = snapshot.tables[0] || "";
      const table = await loadTable();
      const metrics = snapshot.metrics || {};
      const settings = snapshot.settings || {};
      const totalPages = table ? Math.max(1, Math.ceil(Number(table.total || 0) / Number(table.page_size || 50))) : 1;
      const recentRuns = (snapshot.recent_runs || []).map((row) => ({
        id: row.id,
        job_name: row.job_name,
        status: displayRunStatus(row),
        phase: row.phase,
        worker: row.worker,
        started_at: formatDate(row.started_at),
        heartbeat_at: formatDate(row.heartbeat_at),
        duration_ms: row.duration_ms,
        error: row.error,
      }));

      content.innerHTML = `
        <div class="cards twitter-monitor-grid">
          ${renderMetric("X аккаунты", formatNumber(metrics.accounts_total), `+${formatNumber(metrics.accounts_24h)} за 24ч`)}
          ${renderMetric("Discovery candidates", formatNumber(metrics.candidates_total), `+${formatNumber(metrics.candidates_24h)} за 24ч`)}
          ${renderMetric("X posts", formatNumber(metrics.posts_total), `${formatNumber(metrics.posts_24h)} опубликовано за 24ч`)}
          ${renderMetric("Активные runs", formatNumber(metrics.running_runs), `${formatNumber(metrics.stale_running_runs)} stale · ${formatNumber(metrics.failed_runs_24h)} failed · ${formatNumber(metrics.degraded_runs_24h)} degraded`)}
        </div>

        <div class="section-grid">
          <section class="section">
            <div class="section-head"><div><h3>Состояние сборщика</h3><p class="muted">Последние запуски и heartbeat</p></div></div>
            <div class="twitter-health-line">
              ${(snapshot.recent_runs || []).slice(0, 6).map((run) => {
                const status = displayRunStatus(run);
                return `<span class="status-pill ${runStatusClass(status)}">${escapeHtml(run.job_name)} · ${escapeHtml(status)} · ${escapeHtml(run.phase)}</span>`;
              }).join("") || '<span class="muted">Запусков пока нет</span>'}
            </div>
          </section>
          <section class="section">
            <div class="section-head"><div><h3>Очередь discovery</h3><p class="muted">Распределение candidate по статусам</p></div></div>
            ${genericTable(snapshot.candidate_statuses || [], ["status", "count"])}
          </section>
        </div>

        <section class="section full">
          <div class="section-head"><div><h3>Параметры X collector</h3><p class="muted">Изменения применяются к следующим фоновым циклам. CLI override имеет приоритет.</p></div></div>
          <div class="twitter-settings-group"><h4>X / API cycle</h4><div class="twitter-settings-grid">
            ${["enabled", "query_limit", "process_limit", "batch_size", "max_depth", "min_relevance", "network_mode", "network_limit", "lease_seconds", "rescore_limit"].map((name) => inputFor(name, settings[name])).join("")}
          </div></div>
          <div style="height:12px"></div>
          <div class="twitter-settings-group"><h4>Public / no-X-API discovery</h4><div class="twitter-settings-grid">
            ${["public_enabled", "public_dexscreener_latest", "public_dexscreener_boosts", "public_db_solana_tokens", "public_cmc_limit", "public_rescore_limit"].map((name) => inputFor(name, settings[name])).join("")}
          </div></div>
          <div class="twitter-actions"><span class="muted">Версия настроек: ${escapeHtml(formatDate(settings.updated_at))}</span><button id="twitterSaveSettings" class="primary">Сохранить параметры</button></div>
        </section>

        <div style="height:18px"></div>
        <section class="section full">
          <div class="section-head"><div><h3>Последние crawler runs</h3><p class="muted">success / degraded / failed / stale / cancelled / disabled</p></div></div>
          ${genericTable(recentRuns, ["id", "job_name", "status", "phase", "worker", "started_at", "heartbeat_at", "duration_ms", "error"])}
        </section>

        <div style="height:18px"></div>
        <section class="section full">
          <div class="section-head"><div><h3>Новые X аккаунты</h3><p class="muted">Последние 50 аккаунтов, попавших в registry</p></div></div>
          ${genericTable(snapshot.recent_accounts || [], ["id", "twitter_id", "username", "display_name", "account_type", "status", "followers_count", "following_count", "tweet_count", "verified", "source", "first_seen_at", "last_seen_at"])}
        </section>

        <div style="height:18px"></div>
        <section class="section full">
          <div class="section-head"><div><h3>Twitter DB explorer</h3><p class="muted">Read-only таблицы backend registry</p></div></div>
          <div class="twitter-table-toolbar">
            <select id="twitterTableSelect">${snapshot.tables.map((name) => `<option value="${escapeHtml(name)}" ${name === tableName ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select>
            <input id="twitterTableSearch" value="${escapeHtml(tableSearch)}" placeholder="Поиск по выбранной таблице…"/>
            <button id="twitterTableSearchButton" class="secondary">Найти</button>
          </div>
          ${table ? genericTable(table.rows, table.columns?.map((column) => column.name)) : '<div class="empty">Нет доступных Twitter таблиц.</div>'}
          <div class="pagination"><span>${table ? `Строк ${formatNumber(table.total)} · страница ${table.page} из ${totalPages}` : ""}</span><div><button id="twitterPrev" class="small-btn" ${!table || tablePage <= 1 ? "disabled" : ""}>Назад</button><button id="twitterNext" class="small-btn" ${!table || tablePage >= totalPages ? "disabled" : ""}>Дальше</button></div></div>
        </section>`;

      document.querySelector("#twitterSaveSettings")?.addEventListener("click", async () => {
        const button = document.querySelector("#twitterSaveSettings");
        button.disabled = true;
        try {
          const payload = { expected_updated_at: settings.updated_at, ...readSettings() };
          await api("/api/twitter-monitoring/settings", { method: "PUT", body: JSON.stringify(payload) });
          toast("Параметры Twitter collector сохранены");
          await renderTwitterMonitoring();
        } catch (error) {
          toast(error.message, true);
          if (String(error.message).includes("another session") || String(error.message).includes("409")) await renderTwitterMonitoring();
        } finally {
          if (button?.isConnected) button.disabled = false;
        }
      });

      document.querySelector("#twitterTableSelect")?.addEventListener("change", async (event) => {
        tableName = event.target.value; tablePage = 1; tableSearch = ""; await renderTwitterMonitoring();
      });
      const runSearch = async () => {
        tableSearch = document.querySelector("#twitterTableSearch")?.value.trim() || "";
        tablePage = 1;
        await renderTwitterMonitoring();
      };
      document.querySelector("#twitterTableSearchButton")?.addEventListener("click", runSearch);
      document.querySelector("#twitterTableSearch")?.addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });
      document.querySelector("#twitterPrev")?.addEventListener("click", async () => { tablePage = Math.max(1, tablePage - 1); await renderTwitterMonitoring(); });
      document.querySelector("#twitterNext")?.addEventListener("click", async () => { tablePage += 1; await renderTwitterMonitoring(); });
    } catch (error) {
      content.innerHTML = `<div class="empty"><strong>Twitter monitoring недоступен</strong><p>${escapeHtml(error.message)}</p></div>`;
      toast(error.message, true);
    }
  }

  document.querySelector("#twitterMonitoringNav")?.addEventListener("click", async () => {
    await renderTwitterMonitoring();
  });

  document.querySelector("#navigation")?.addEventListener("click", (event) => {
    const navItem = event.target.closest(".nav-item");
    if (navItem && navItem.id !== "twitterMonitoringNav") active = false;
  }, true);

  document.querySelector("#refreshButton")?.addEventListener("click", async (event) => {
    if (!active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    await renderTwitterMonitoring();
  }, true);

  document.querySelector("#logoutButton")?.addEventListener("click", () => { active = false; }, true);
})();
