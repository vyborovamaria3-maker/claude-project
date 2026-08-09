// Database dashboard migrated from the public Solana Launcher into the protected admin console.
// Uses the production PostgreSQL source and the existing read-only admin APIs.

function databaseSection(title, subtitle, body) {
  return `<section class="section full"><div class="section-head"><div><h3>${escapeHtml(title)}</h3>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div></div>${body}</section>`;
}

function databaseDomainSection(title, subtitle, data, emptyText) {
  const total = Object.values(data?.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  return databaseSection(
    title,
    `${subtitle} · ${formatNumber(total)} записей`,
    renderDomainData(data || { sections: [] }, emptyText)
  );
}

async function databaseTablePreview(sourceId, table, pageSize = 50) {
  if (!sourceId || !table) return null;
  try {
    return await api(`/api/sources/${encodeURIComponent(sourceId)}/tables/${encodeURIComponent(table)}?page=1&page_size=${pageSize}`);
  } catch {
    return null;
  }
}

function databasePreviewCard(title, data) {
  if (!data) return "";
  const columns = data.columns?.map((item) => item.name) || null;
  return `<article class="domain-card"><h3>${escapeHtml(title)}</h3><div class="domain-meta"><span>${formatNumber(data.total)} строк</span><span>•</span><span>production PostgreSQL</span></div>${genericTable(data.rows || [], columns)}</article>`;
}

renderDatabase = async function renderMigratedDatabase(reset = false) {
  loading();

  const [sourcesData, overview, blockchain, telegram, xData, usersData] = await Promise.all([
    api("/api/sources"),
    api("/api/overview"),
    api("/api/blockchain?limit=100").catch(() => ({ counts: {}, sections: [] })),
    api("/api/social/telegram?limit=100").catch(() => ({ counts: {}, sections: [], users: [] })),
    api("/api/social/x?limit=100").catch(() => ({ counts: {}, sections: [] })),
    api("/api/users?limit=1000").catch(() => ({ total: 0, rows: [] })),
  ]);

  const sources = sourcesData.sources.filter((source) => source.ok);
  if (reset || !state.db.source || !sources.some((source) => source.id === state.db.source)) {
    state.db.source = sources[0]?.id || "";
    state.db.table = "";
    state.db.page = 1;
  }

  if (state.db.source) await loadSourceTables(state.db.source);
  const data = await fetchDbRows();
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const columns = data?.columns?.map((item) => item.name) || [];
  const availableTables = new Set(state.db.tables.map((item) => item.name));

  const previewNames = [
    "wallets",
    "wallet_trades",
    "tokens",
    "token_metrics",
    "subscription_orders",
    "subscription_settings",
    "telegram_calls",
    "telegram_channel_scores",
    "telegram_token_mentions",
    "collector_jobs",
    "social_events",
    "social_relations",
    "auth_logs",
  ].filter((name) => availableTables.has(name));

  const previewPairs = await Promise.all(
    previewNames.map(async (name) => [name, await databaseTablePreview(state.db.source, name, 50)])
  );
  const previews = Object.fromEntries(previewPairs);

  const sourceStatus = sourcesData.sources.map((source) =>
    `<div class="status-row"><div><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.kind)} · ${escapeHtml(source.role)}</small></div><div class="mono">${formatNumber(source.tables)} tbl / ${formatNumber(source.rows)} rows</div><span class="status-pill ${source.ok ? "ok" : "bad"}">${source.ok ? "online" : "offline"}</span></div>`
  ).join("");

  const subscriptionCards = ["subscription_orders", "subscription_settings"]
    .map((name) => databasePreviewCard(name, previews[name]))
    .filter(Boolean)
    .join("");

  const walletCards = ["wallets", "wallet_trades", "tokens", "token_metrics"]
    .map((name) => databasePreviewCard(name, previews[name]))
    .filter(Boolean)
    .join("");

  const intelligenceCards = [
    "telegram_calls",
    "telegram_channel_scores",
    "telegram_token_mentions",
    "collector_jobs",
    "social_events",
    "social_relations",
    "auth_logs",
  ].map((name) => databasePreviewCard(name, previews[name])).filter(Boolean).join("");

  const telegramUsers = telegram.users || usersData.rows.filter((row) => row.telegram_id || row.telegram_username);

  content.innerHTML = `
    <div class="cards">
      ${renderMetric("Production DB", overview.healthy_sources + " / " + overview.total_sources, "источников online")}
      ${renderMetric("Таблицы", formatNumber(overview.total_tables), "перенесено в админку")}
      ${renderMetric("Строки", formatNumber(overview.total_rows), "read-only production")}
      ${renderMetric("Пользователи", formatNumber(usersData.total), "основная база")}
      ${renderMetric("Telegram users", formatNumber(telegramUsers.length), "production data")}
    </div>

    ${databaseSection(
      "Состояние production-базы",
      "Раздел База данных перенесён с основного сайта. Источники доступны только после входа в админку.",
      `<div class="status-list">${sourceStatus || '<div class="empty">Нет подключённых источников.</div>'}</div>`
    )}

    ${databaseSection(
      "Wallet analytics, токены и сделки",
      "Кошельки, PnL/сделки, токены и метрики из production PostgreSQL.",
      walletCards ? `<div class="domain-sections">${walletCards}</div>` : '<div class="empty">Wallet/token таблицы пока не найдены.</div>'
    )}

    ${databaseDomainSection(
      "Blockchain / Solana datasets",
      "Все доступные blockchain-таблицы, ранее показанные на основном сайте",
      blockchain,
      "Blockchain-таблицы пока не найдены."
    )}

    ${databaseSection(
      "Telegram intelligence",
      "Пользователи, каналы, сообщения, calls, scoring и token mentions.",
      `<article class="domain-card"><h3>Telegram users</h3>${genericTable(telegramUsers, ["source", "id", "login", "telegram_id", "telegram_username", "created_at", "last_login_at", "subscription_expires_at", "active"])}</article><div style="height:18px"></div>${renderDomainData(telegram, "Telegram-таблицы пока не найдены.")}`
    )}

    ${databaseDomainSection(
      "X / Twitter intelligence",
      "Анализы, social events/accounts и связанные наборы данных",
      xData,
      "X/Twitter-таблицы пока не найдены."
    )}

    ${databaseSection(
      "Подписки",
      "Заказы и настройки подписок перенесены в защищённую часть.",
      subscriptionCards ? `<div class="domain-sections">${subscriptionCards}</div>` : '<div class="empty">Subscription-таблицы пока не найдены.</div>'
    )}

    ${databaseSection(
      "Служебные данные и события",
      "Collector jobs, social relations/events, Telegram scoring и auth logs.",
      intelligenceCards ? `<div class="domain-sections">${intelligenceCards}</div>` : '<div class="empty">Служебные таблицы пока не найдены.</div>'
    )}

    <section class="section full">
      <div class="section-head">
        <div><h3>Read-only explorer</h3><p>Полный просмотр всех таблиц, поиск, пагинация и CSV export.</p></div>
        ${state.db.source && state.db.table ? `<a class="small-btn" href="/api/sources/${encodeURIComponent(state.db.source)}/tables/${encodeURIComponent(state.db.table)}/export.csv">CSV экспорт</a>` : ""}
      </div>
      <div class="toolbar">
        <select id="dbSource">${sources.map((source) => `<option value="${escapeHtml(source.id)}" ${source.id === state.db.source ? "selected" : ""}>${escapeHtml(source.label)}</option>`).join("")}</select>
        <select id="dbTable">${state.db.tables.map((table) => `<option value="${escapeHtml(table.name)}" ${table.name === state.db.table ? "selected" : ""}>${escapeHtml(table.name)} (${formatNumber(table.rows)})</option>`).join("")}</select>
        <input id="dbSearch" value="${escapeHtml(state.db.search)}" placeholder="Поиск…" />
        <button id="dbSearchButton" class="secondary">Найти</button>
      </div>
      ${data ? genericTable(data.rows, columns) : '<div class="empty">Нет подключённых таблиц.</div>'}
      <div class="pagination">
        <span>${data ? `Строк ${formatNumber(data.total)} · страница ${data.page} из ${totalPages}` : ""}</span>
        <div>
          <button id="dbPrev" class="small-btn" ${!data || data.page <= 1 ? "disabled" : ""}>Назад</button>
          <button id="dbNext" class="small-btn" ${!data || data.page >= totalPages ? "disabled" : ""}>Дальше</button>
        </div>
      </div>
    </section>
  `;

  $("#dbSource")?.addEventListener("change", async (event) => {
    state.db.source = event.target.value;
    state.db.table = "";
    state.db.page = 1;
    state.db.search = "";
    await renderDatabase();
  });
  $("#dbTable")?.addEventListener("change", async (event) => {
    state.db.table = event.target.value;
    state.db.page = 1;
    state.db.search = "";
    await renderDatabase();
  });
  const runSearch = async () => {
    state.db.search = $("#dbSearch").value.trim();
    state.db.page = 1;
    await renderDatabase();
  };
  $("#dbSearchButton")?.addEventListener("click", runSearch);
  $("#dbSearch")?.addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });
  $("#dbPrev")?.addEventListener("click", async () => { state.db.page -= 1; await renderDatabase(); });
  $("#dbNext")?.addEventListener("click", async () => { state.db.page += 1; await renderDatabase(); });
};
