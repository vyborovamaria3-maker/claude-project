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

function databaseEntityCards(inventory) {
  const entities = inventory?.entities || {};
  const cards = [
    ["Кошельки", entities.wallets, "wallet datasets"],
    ["Монеты / токены", entities.coins, "token datasets"],
    ["X / Twitter аккаунты", entities.twitter_accounts, "accounts"],
    ["X / Twitter записи", entities.twitter_posts, "tweets / mentions / posts"],
    ["Telegram аккаунты", entities.telegram_accounts, "users"],
    ["Telegram каналы", entities.telegram_channels, "channels"],
    ["Telegram сообщения", entities.telegram_messages, "messages / posts"],
    ["Пользователи", entities.users, "user tables"],
    ["Сделки", entities.trades, "wallet / token trades"],
    ["Сигналы", entities.signals, "calls / events / AI results"],
    ["Платежи", entities.payments, "payment records"],
  ];
  return `<div class="cards">${cards.map(([label, value, sub]) => renderMetric(label, formatNumber(value || 0), sub)).join("")}</div>`;
}

function databaseSchemaInventory(inventory) {
  const sources = inventory?.sources || [];
  if (!sources.length) return '<div class="empty">Источники базы данных не подключены.</div>';
  return `<div class="domain-sections">${sources.map((source) => {
    const tables = source.tables || [];
    const tableHtml = tables.map((table) => {
      if (!table.ok) return `<article class="domain-card"><h3>${escapeHtml(table.name)}</h3><div class="error-text">Таблица недоступна</div></article>`;
      const columns = table.columns || [];
      const columnRows = columns.map((column) => ({
        parameter: column.name,
        type: column.type,
        nullable: column.nullable ? "yes" : "no",
        primary_key: column.primary_key ? "yes" : "no",
      }));
      return `<article class="domain-card"><h3>${escapeHtml(table.name)}</h3><div class="domain-meta"><span>${formatNumber(table.rows || 0)} строк</span><span>•</span><span>${formatNumber(table.column_count || columns.length)} параметров</span></div>${genericTable(columnRows, ["parameter", "type", "nullable", "primary_key"])}</article>`;
    }).join("");
    return `<section class="section full"><div class="section-head"><div><h3>${escapeHtml(source.label)}</h3><p>${escapeHtml(source.kind)} · ${escapeHtml(source.role)} · ${formatNumber(source.table_count)} таблиц · ${formatNumber(source.column_count)} параметров · ${formatNumber(source.row_count)} строк</p></div><span class="status-pill ${source.ok ? "ok" : "bad"}">${source.ok ? "online" : "offline"}</span></div>${tableHtml || '<div class="empty">Таблиц нет.</div>'}</section>`;
  }).join("")}</div>`;
}

renderDatabase = async function renderMigratedDatabase(reset = false) {
  loading();

  const [sourcesData, overview, inventory, blockchain, telegram, xData, usersData] = await Promise.all([
    api("/api/sources"),
    api("/api/overview"),
    api("/api/database/inventory").catch(() => ({ totals: {}, entities: {}, sources: [] })),
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
  const totalLabel = data?.total_is_estimate ? `~${formatNumber(data.total)}` : formatNumber(data?.total || 0);

  content.innerHTML = `
    <div class="cards">
      ${renderMetric("Production DB", overview.healthy_sources + " / " + overview.total_sources, "источников online")}
      ${renderMetric("Таблицы", formatNumber(inventory.totals?.tables ?? overview.total_tables), "все подключённые таблицы")}
      ${renderMetric("Параметры", formatNumber(inventory.totals?.columns || 0), "все колонки таблиц")}
      ${renderMetric("Строки", formatNumber(inventory.totals?.rows ?? overview.total_rows), "быстрая оценка")}
      ${renderMetric("Пользователи", formatNumber(usersData.total), "основная база")}
    </div>

    ${databaseSection(
      "Счётчики сущностей",
      "Быстрые агрегаты по всем подключённым таблицам. Значения берутся из метаданных PostgreSQL без тяжёлого COUNT(*) на каждую таблицу.",
      databaseEntityCards(inventory)
    )}

    ${databaseSection(
      "Состояние production-базы",
      "Все источники доступны только после входа в админку.",
      `<div class="status-list">${sourceStatus || '<div class="empty">Нет подключённых источников.</div>'}</div>`
    )}

    ${databaseSection(
      "Полная структура базы данных",
      "Каждая база, каждая таблица и все параметры/колонки с типами, nullable и primary key.",
      databaseSchemaInventory(inventory)
    )}

    ${databaseSection(
      "Wallet analytics, токены и сделки",
      "Кошельки, PnL/сделки, токены и метрики из production PostgreSQL.",
      walletCards ? `<div class="domain-sections">${walletCards}</div>` : '<div class="empty">Wallet/token таблицы пока не найдены.</div>'
    )}

    ${databaseDomainSection(
      "Blockchain / Solana datasets",
      "Все доступные blockchain-таблицы",
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
      "Аккаунты, анализы, tweets, mentions, social events и связанные наборы данных",
      xData,
      "X/Twitter-таблицы пока не найдены."
    )}

    ${databaseSection(
      "Подписки",
      "Заказы и настройки подписок в защищённой части.",
      subscriptionCards ? `<div class="domain-sections">${subscriptionCards}</div>` : '<div class="empty">Subscription-таблицы пока не найдены.</div>'
    )}

    ${databaseSection(
      "Служебные данные и события",
      "Collector jobs, social relations/events, Telegram scoring и auth logs.",
      intelligenceCards ? `<div class="domain-sections">${intelligenceCards}</div>` : '<div class="empty">Служебные таблицы пока не найдены.</div>'
    )}

    <section class="section full">
      <div class="section-head">
        <div><h3>Read-only explorer</h3><p>Полный просмотр строк, поиск, пагинация и CSV export.</p></div>
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
        <span>${data ? `Строк ${totalLabel} · страница ${data.page} из ${totalPages}` : ""}</span>
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
