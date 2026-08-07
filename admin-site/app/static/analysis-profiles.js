(() => {
  const DOMAIN_LABELS = {
    wallet: "Кошельки / Creator",
    token: "Токены",
    telegram: "Telegram",
    x: "X / Twitter",
  };

  const VALUE_TYPES = [
    ["number", "Число"],
    ["percent", "Процент"],
    ["currency", "USD"],
    ["duration", "Время"],
    ["boolean", "Да / нет"],
    ["score", "Score"],
    ["text", "Текст"],
  ];

  const DEFAULTS = {
    wallet: [
      { key: "total_created_tokens", label: "Создано токенов", source: "totalCreatedTokens", type: "number", threshold: "", description: "Количество токенов, созданных кошельком / creator." },
      { key: "migration_rate", label: "Migration rate", source: "migrationRate", type: "percent", threshold: ">= 20%", description: "Доля созданных токенов, дошедших до migration." },
      { key: "success_rate", label: "Success rate", source: "successRate", type: "percent", threshold: ">= 15%", description: "Доля токенов, достигших целевой капитализации." },
      { key: "avg_lifespan", label: "Средний lifespan", source: "avgLifespanHours", type: "duration", threshold: ">= 2h", description: "Среднее время активности токенов creator." },
      { key: "median_lifespan", label: "Median lifespan", source: "medianLifespanHours", type: "duration", threshold: "", description: "Медианное время жизни токенов creator." },
      { key: "average_token_volume", label: "Средний объём токена", source: "averageTokenVolumeUsd", type: "currency", threshold: "", description: "Средний resolved volume по токенам creator." },
      { key: "average_creator_fees", label: "Средние creator fees", source: "averageCreatorFeesUsd", type: "currency", threshold: "", description: "Средние комиссии creator по истории запусков." },
      { key: "migrated_tokens", label: "Migrated tokens", source: "totalMigratedTokens", type: "number", threshold: "", description: "Количество мигрировавших токенов." },
      { key: "network_volume", label: "Объём сети при анализе", source: "currentNetworkVolumeM", type: "currency", threshold: "", description: "Текущий Solana/Pump volume, используемый в корреляции запуска." },
      { key: "optimal_launch_time", label: "Оптимальное время запуска", source: "isOptimalLaunchTime", type: "boolean", threshold: "true", description: "Попадает ли текущий network volume в исторически оптимальный диапазон." },
    ],
    token: [
      { key: "token_volume_usd", label: "Token volume", source: "tokenVolumeUsd", type: "currency", threshold: "", description: "Resolved объём торгов токена в USD." },
      { key: "ath_usd", label: "ATH", source: "athUsd", type: "currency", threshold: "", description: "Исторический максимум токена." },
      { key: "peak_market_cap", label: "Peak market cap", source: "peakMarketCap", type: "currency", threshold: ">= $100k", description: "Пиковая капитализация токена." },
      { key: "lifespan_hours", label: "Lifespan", source: "lifespanHours", type: "duration", threshold: "", description: "Время жизни / активности токена." },
      { key: "is_migrated", label: "Migrated", source: "isMigrated", type: "boolean", threshold: "true", description: "Факт migration токена." },
      { key: "creator_fees", label: "Creator fees", source: "creatorFeesUsd", type: "currency", threshold: "", description: "Комиссии creator по конкретному токену." },
      { key: "total_fees", label: "Total fees", source: "totalFeesUsd", type: "currency", threshold: "", description: "Суммарные комиссии токена." },
      { key: "migration_market_cap", label: "Migration market cap", source: "migrationMarketCap", type: "currency", threshold: "", description: "Капитализация на момент migration." },
      { key: "social_bot_score", label: "Social bot score", source: "twitter.botScore", type: "score", threshold: "<= 35", description: "Bot score связанного X/Twitter аккаунта." },
      { key: "social_followers", label: "X followers", source: "twitter.followers", type: "number", threshold: "", description: "Количество подписчиков связанного X аккаунта." },
      { key: "social_avg_views", label: "X avg views", source: "twitter.avgViews", type: "number", threshold: "", description: "Среднее число просмотров постов." },
      { key: "social_avg_likes", label: "X avg likes", source: "twitter.avgLikes", type: "number", threshold: "", description: "Среднее число лайков постов." },
    ],
    telegram: [
      { key: "participants", label: "Участники", source: "participants", type: "number", threshold: "", description: "Размер Telegram канала / группы." },
      { key: "channel_score", label: "Channel score", source: "score", type: "score", threshold: ">= 60", description: "Итоговый score источника / caller." },
      { key: "calls_count", label: "Количество calls", source: "calls_count", type: "number", threshold: "", description: "Число обнаруженных token calls." },
      { key: "win_rate", label: "Win rate", source: "win_rate", type: "percent", threshold: ">= 50%", description: "Доля успешных calls." },
      { key: "rug_rate", label: "Rug rate", source: "rug_rate", type: "percent", threshold: "<= 15%", description: "Доля calls, закончившихся rug / критическим падением." },
      { key: "avg_roi", label: "Средний ROI", source: "avg_roi", type: "percent", threshold: "> 0%", description: "Средний ROI по истории calls." },
      { key: "wins", label: "Wins", source: "wins", type: "number", threshold: "", description: "Абсолютное число успешных calls caller." },
      { key: "entity_type", label: "Тип источника", source: "entity_type", type: "text", threshold: "", description: "Channel, group, caller или другой Telegram entity type." },
    ],
    x: [
      { key: "total_tweets", label: "Tweets / mentions", source: "totalTweets", type: "number", threshold: "", description: "Количество найденных X/Twitter публикаций." },
      { key: "total_views", label: "Views", source: "totalViews", type: "number", threshold: "", description: "Суммарные просмотры найденных публикаций." },
      { key: "total_likes", label: "Likes", source: "totalLikes", type: "number", threshold: "", description: "Суммарные лайки." },
      { key: "total_retweets", label: "Retweets", source: "totalRetweets", type: "number", threshold: "", description: "Суммарные ретвиты / reposts." },
      { key: "unique_mentioners", label: "Unique mentioners", source: "uniqueMentioners", type: "number", threshold: "", description: "Количество уникальных аккаунтов, упомянувших токен." },
      { key: "bot_risk_score", label: "Bot risk", source: "botRiskScore", type: "score", threshold: "<= 35", description: "Оценка риска ботов / искусственного продвижения." },
      { key: "anomaly_count", label: "Anomalies", source: "anomalyCount", type: "number", threshold: "<= 3", description: "Количество обнаруженных аномалий активности." },
      { key: "engagement_rate", label: "Engagement rate", source: "aggregated.engagementRate", type: "percent", threshold: "", description: "Агрегированный engagement rate." },
      { key: "verified_authors", label: "Verified authors", source: "aggregated.verifiedAuthors", type: "number", threshold: "", description: "Количество verified авторов в выборке." },
      { key: "bot_ratio", label: "Bot ratio", source: "aggregated.botRatio", type: "percent", threshold: "<= 25%", description: "Доля подозреваемых bot accounts." },
      { key: "discovery_mentions", label: "Discovery mentions", source: "discovery.mentions", type: "number", threshold: "", description: "Упоминания, найденные discovery-пайплайном." },
      { key: "discovery_accounts", label: "Discovery accounts", source: "discovery.accounts", type: "number", threshold: "", description: "Количество аккаунтов в discovery-пайплайне." },
    ],
  };

  let currentDomain = "wallet";
  let analysisActive = false;
  let flagRows = [];

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function notify(message, isError = false) {
    if (typeof toast === "function") toast(message, isError);
  }

  async function request(path, options = {}) {
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

  function flagName(domain, key) {
    return `analysis.${domain}.${key}`;
  }

  function parseMetadata(description) {
    if (!description || !description.startsWith("{")) return null;
    try {
      const parsed = JSON.parse(description);
      return parsed && parsed.analysisProfile === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  function serializeMetadata(row, extra = {}) {
    return JSON.stringify({
      analysisProfile: 1,
      custom: Boolean(row.custom),
      deleted: false,
      label: row.label,
      source: row.source,
      type: row.type,
      threshold: row.threshold || "",
      description: row.description || "",
      ...extra,
    });
  }

  function rowsForDomain(domain) {
    const flags = new Map(flagRows.map((row) => [row.name, row]));
    const builtins = (DEFAULTS[domain] || []).map((item) => {
      const flag = flags.get(flagName(domain, item.key));
      const metadata = parseMetadata(flag?.description);
      return {
        ...item,
        ...(metadata ? {
          label: metadata.label || item.label,
          source: metadata.source || item.source,
          type: metadata.type || item.type,
          threshold: metadata.threshold ?? item.threshold,
          description: metadata.description ?? item.description,
        } : {}),
        enabled: flag ? Boolean(flag.enabled) : true,
        custom: false,
        deleted: false,
      };
    });

    const builtinKeys = new Set(builtins.map((row) => row.key));
    const custom = [];
    for (const flag of flagRows) {
      const prefix = `analysis.${domain}.`;
      if (!flag.name.startsWith(prefix)) continue;
      const key = flag.name.slice(prefix.length);
      if (!key || builtinKeys.has(key)) continue;
      const metadata = parseMetadata(flag.description);
      if (!metadata?.custom || metadata.deleted) continue;
      custom.push({
        key,
        label: metadata.label || key,
        source: metadata.source || key,
        type: metadata.type || "number",
        threshold: metadata.threshold || "",
        description: metadata.description || "",
        enabled: Boolean(flag.enabled),
        custom: true,
        deleted: false,
      });
    }
    return [...builtins, ...custom].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label, "ru"));
  }

  function typeLabel(type) {
    return VALUE_TYPES.find(([value]) => value === type)?.[1] || type;
  }

  async function saveRow(domain, row, enabled, extraMetadata = {}) {
    const name = flagName(domain, row.key);
    const metadata = serializeMetadata(row, extraMetadata);
    if (metadata.length > 490) throw new Error("Описание параметра слишком длинное");
    await request(`/api/feature-flags/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ name, enabled, description: metadata }),
    });
  }

  async function loadFlags() {
    const data = await request("/api/feature-flags");
    flagRows = Array.isArray(data.rows) ? data.rows : [];
  }

  function renderTabs() {
    return `<div class="analysis-tabs">${Object.entries(DOMAIN_LABELS).map(([domain, label]) =>
      `<button type="button" class="analysis-tab ${domain === currentDomain ? "active" : ""}" data-analysis-domain="${domain}">${esc(label)}</button>`
    ).join("")}</div>`;
  }

  function renderParameterTable(rows) {
    return `<div class="table-shell analysis-table-shell"><table class="analysis-table"><thead><tr>
      <th>Статус</th><th>Параметр</th><th>Поле данных</th><th>Тип</th><th>Порог</th><th>Источник</th><th></th>
    </tr></thead><tbody>${rows.map((row) => `<tr class="${row.enabled ? "" : "analysis-disabled"}">
      <td><button type="button" class="analysis-switch ${row.enabled ? "on" : ""}" data-analysis-toggle="${esc(row.key)}" aria-label="${row.enabled ? "Убрать" : "Вернуть"} параметр"><span></span>${row.enabled ? "ON" : "OFF"}</button></td>
      <td><strong>${esc(row.label)}</strong><small>${esc(row.description)}</small><code>${esc(row.key)}</code></td>
      <td><code>${esc(row.source)}</code></td>
      <td><span class="analysis-type">${esc(typeLabel(row.type))}</span></td>
      <td>${row.threshold ? `<span class="analysis-threshold">${esc(row.threshold)}</span>` : "—"}</td>
      <td><span class="analysis-origin ${row.custom ? "custom" : "builtin"}">${row.custom ? "custom" : "project"}</span></td>
      <td>${row.custom ? `<button type="button" class="small-btn analysis-delete" data-analysis-delete="${esc(row.key)}">Удалить</button>` : `<button type="button" class="small-btn" data-analysis-toggle="${esc(row.key)}">${row.enabled ? "Убрать" : "Вернуть"}</button>`}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function renderAddForm() {
    return `<details class="analysis-add"><summary>+ Добавить свой параметр</summary>
      <form id="analysisAddForm" class="analysis-form">
        <label>Ключ<input id="analysisKey" maxlength="64" placeholder="smart_money_ratio" required /></label>
        <label>Название<input id="analysisLabel" maxlength="80" placeholder="Smart money ratio" required /></label>
        <label>Поле данных<input id="analysisSource" maxlength="100" placeholder="metrics.smartMoneyRatio" required /></label>
        <label>Тип<select id="analysisType">${VALUE_TYPES.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("")}</select></label>
        <label>Порог<input id="analysisThreshold" maxlength="40" placeholder=">= 25%" /></label>
        <label class="analysis-form-wide">Описание<input id="analysisDescription" maxlength="160" placeholder="Что означает параметр и зачем он нужен" /></label>
        <div class="analysis-form-actions"><button class="primary" type="submit">Добавить и включить</button></div>
      </form>
    </details>`;
  }

  function bindControls(rows) {
    document.querySelectorAll("[data-analysis-domain]").forEach((button) => {
      button.addEventListener("click", () => {
        currentDomain = button.dataset.analysisDomain;
        renderAnalysisProfiles();
      });
    });

    document.querySelectorAll("[data-analysis-toggle]").forEach((button) => {
      button.addEventListener("click", async () => {
        const key = button.dataset.analysisToggle;
        const row = rows.find((item) => item.key === key);
        if (!row) return;
        button.disabled = true;
        try {
          await saveRow(currentDomain, row, !row.enabled);
          notify(row.enabled ? "Параметр убран из активного анализа" : "Параметр возвращён в анализ");
          await renderAnalysisProfiles(true);
        } catch (error) {
          notify(error.message, true);
          button.disabled = false;
        }
      });
    });

    document.querySelectorAll("[data-analysis-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const key = button.dataset.analysisDelete;
        const row = rows.find((item) => item.key === key && item.custom);
        if (!row) return;
        button.disabled = true;
        try {
          await saveRow(currentDomain, row, false, { deleted: true });
          notify("Пользовательский параметр удалён из профиля");
          await renderAnalysisProfiles(true);
        } catch (error) {
          notify(error.message, true);
          button.disabled = false;
        }
      });
    });

    document.querySelector("#analysisAddForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = document.querySelector("#analysisKey").value.trim().toLowerCase().replaceAll(" ", "_");
      if (!/^[a-z0-9_.-]{2,64}$/.test(key)) {
        notify("Ключ: только a-z, 0-9, точка, _ или -", true);
        return;
      }
      if ((DEFAULTS[currentDomain] || []).some((item) => item.key === key)) {
        notify("Такой системный параметр уже существует — его можно включить или выключить", true);
        return;
      }
      const row = {
        key,
        label: document.querySelector("#analysisLabel").value.trim(),
        source: document.querySelector("#analysisSource").value.trim(),
        type: document.querySelector("#analysisType").value,
        threshold: document.querySelector("#analysisThreshold").value.trim(),
        description: document.querySelector("#analysisDescription").value.trim(),
        custom: true,
      };
      if (!row.label || !row.source) return;
      try {
        await saveRow(currentDomain, row, true);
        notify("Новый параметр добавлен в профиль анализа");
        await renderAnalysisProfiles(true);
      } catch (error) {
        notify(error.message, true);
      }
    });
  }

  async function renderAnalysisProfiles(forceReload = false) {
    analysisActive = true;
    try {
      if (typeof state !== "undefined") state.view = "analysis";
      if (typeof titles !== "undefined") titles.analysis = "Параметры анализа";
    } catch {}

    const title = document.querySelector("#viewTitle");
    if (title) title.textContent = "Параметры анализа";
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === "analysis"));
    const target = document.querySelector("#content");
    if (!target) return;
    target.innerHTML = `<div class="loading"><span></span><p>Загрузка профилей анализа…</p></div>`;

    try {
      if (forceReload || !flagRows.length) await loadFlags();
      const rows = rowsForDomain(currentDomain);
      const active = rows.filter((row) => row.enabled).length;
      const custom = rows.filter((row) => row.custom).length;
      target.innerHTML = `
        <div class="analysis-hero">
          <div><p class="eyebrow">ANALYSIS CONTROL PLANE</p><h3>Настраиваемые параметры анализа</h3><p>Убирайте ненужные метрики, возвращайте их обратно или добавляйте свои. Настройки хранятся отдельно от продуктовых read-only баз.</p></div>
          <div class="analysis-stats"><div><strong>${active}</strong><span>активно</span></div><div><strong>${rows.length}</strong><span>в профиле</span></div><div><strong>${custom}</strong><span>своих</span></div></div>
        </div>
        ${renderTabs()}
        <section class="section full analysis-section">
          <div class="section-head"><div><h3>${esc(DOMAIN_LABELS[currentDomain])}</h3><p>Активные параметры входят в текущий профиль анализа Control Center.</p></div><span class="status-pill ok">${active} active</span></div>
          ${renderParameterTable(rows)}
          ${renderAddForm()}
        </section>`;
      bindControls(rows);
    } catch (error) {
      target.innerHTML = `<div class="empty"><strong>Не удалось загрузить параметры анализа</strong><p>${esc(error.message)}</p></div>`;
      notify(error.message, true);
    }
  }

  const navButton = document.querySelector("#analysisProfilesNav");
  navButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    renderAnalysisProfiles(true);
  });

  document.querySelector("#navigation")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button && button.dataset.view !== "analysis") analysisActive = false;
  });

  document.querySelector("#refreshButton")?.addEventListener("click", () => {
    if (analysisActive) setTimeout(() => renderAnalysisProfiles(true), 0);
  });
})();
