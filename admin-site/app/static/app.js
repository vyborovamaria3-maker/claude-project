const state = {
  view: "overview",
  me: null,
  overview: null,
  db: { source: "", table: "", page: 1, pageSize: 50, search: "", tables: [], data: null },
  logs: { id: "", search: "", lines: 300 },
};

const titles = {
  overview: "Обзор системы", database: "Базы данных", blockchain: "Блокчейн и Solana",
  telegram: "Telegram", x: "X / Twitter", users: "Пользователи", logs: "Логи сервисов",
  search: "Глобальный поиск", graph: "Граф связей", queues: "Очереди и задания",
  monitoring: "Мониторинг", control: "Control Center", audit: "Аудит администратора",
};

const $ = (selector) => document.querySelector(selector);
const content = $("#content");
const loginView = $("#loginView");
const appView = $("#appView");

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function formatNumber(value) { return new Intl.NumberFormat("ru-RU", { notation: Number(value) > 999999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(value || 0)); }
function formatDate(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium" }).format(date); }
function toast(message, isError = false) { const el = $("#toast"); el.textContent = message; el.className = `toast show${isError ? " error" : ""}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = "toast"; }, 3200); }

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  if (response.status === 401) { showLogin(); throw new Error("Требуется вход"); }
  if (!response.ok) { let detail = `HTTP ${response.status}`; try { detail = (await response.json()).detail || detail; } catch {} throw new Error(detail); }
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response.text();
}
function loading() { content.replaceChildren($("#loadingTemplate").content.cloneNode(true)); }
function showLogin() { appView.classList.add("hidden"); loginView.classList.remove("hidden"); }
function showApp() { loginView.classList.add("hidden"); appView.classList.remove("hidden"); $("#adminIdentity").textContent = state.me?.username || "admin"; }
function renderMetric(label, value, sub = "") { return `<article class="card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-sub">${escapeHtml(sub)}</div></article>`; }
function cell(value) { if (value === null || value === undefined || value === "") return "—"; if (typeof value === "object") return `<span class="json-cell">${escapeHtml(JSON.stringify(value))}</span>`; const text = String(value); return `<span title="${escapeHtml(text)}">${escapeHtml(text.length > 140 ? `${text.slice(0, 137)}…` : text)}</span>`; }
function genericTable(rows, columns = null) {
  if (!rows?.length) return `<div class="empty">Данных пока нет или источник не подключён.</div>`;
  const names = columns || Array.from(rows.reduce((set, row) => { Object.keys(row || {}).forEach((key) => set.add(key)); return set; }, new Set()));
  return `<div class="table-shell"><table><thead><tr>${names.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${names.map((name) => `<td>${cell(row?.[name])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

async function renderOverview() {
  loading(); const data = state.overview = await api("/api/overview");
  const sourceRows = data.sources.map((source) => `<div class="status-row"><div><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.kind)} · ${escapeHtml(source.role)}</small></div><div class="mono">${formatNumber(source.tables)} tbl / ${formatNumber(source.rows)} rows</div><span class="status-pill ${source.ok ? "ok" : "bad"}">${source.ok ? "online" : "offline"}</span></div>`).join("");
  const logRows = data.logs.map((log) => `<div class="status-row"><div><strong>${escapeHtml(log.label)}</strong><small>${escapeHtml(log.path)}</small></div><div class="mono">${formatNumber(log.size)} B</div><span class="status-pill ${log.exists ? "ok" : "warn"}">${log.exists ? "mounted" : "missing"}</span></div>`).join("");
  content.innerHTML = `<div class="cards">${renderMetric("Источники", data.total_sources, `${data.healthy_sources} доступны`)}${renderMetric("Таблицы", formatNumber(data.total_tables), "во всех базах")}${renderMetric("Строки", formatNumber(data.total_rows), "read-only индекс")}${renderMetric("Пользователи", formatNumber(data.total_users), "объединённый список")}${renderMetric("Логи", data.logs.length, "подключённые файлы")}</div><div class="section-grid"><section class="section"><div class="section-head"><div><h3>Состояние баз</h3></div></div><div class="status-list">${sourceRows || '<div class="empty">Добавьте sources.json</div>'}</div></section><section class="section"><div class="section-head"><div><h3>Состояние логов</h3></div></div><div class="status-list">${logRows || '<div class="empty">Добавьте logs.json</div>'}</div></section></div>`;
}

async function loadSourceTables(sourceId) { const data = await api(`/api/sources/${encodeURIComponent(sourceId)}/tables`); state.db.tables = data.tables; if (!state.db.table || !data.tables.some((item) => item.name === state.db.table)) state.db.table = data.tables[0]?.name || ""; }
async function fetchDbRows() { if (!state.db.source || !state.db.table) return null; const params = new URLSearchParams({ page: state.db.page, page_size: state.db.pageSize, search: state.db.search }); state.db.data = await api(`/api/sources/${encodeURIComponent(state.db.source)}/tables/${encodeURIComponent(state.db.table)}?${params}`); return state.db.data; }
async function renderDatabase(reset = false) {
  loading(); const sourcesData = await api("/api/sources"); const sources = sourcesData.sources.filter((source) => source.ok);
  if (reset || !state.db.source || !sources.some((source) => source.id === state.db.source)) { state.db.source = sources[0]?.id || ""; state.db.table = ""; state.db.page = 1; }
  if (state.db.source) await loadSourceTables(state.db.source); const data = await fetchDbRows(); const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1; const columns = data?.columns?.map((item) => item.name) || [];
  content.innerHTML = `<section class="section full"><div class="section-head"><div><h3>Read-only explorer</h3></div>${state.db.source && state.db.table ? `<a class="small-btn" href="/api/sources/${encodeURIComponent(state.db.source)}/tables/${encodeURIComponent(state.db.table)}/export.csv">CSV экспорт</a>` : ""}</div><div class="toolbar"><select id="dbSource">${sources.map((source) => `<option value="${escapeHtml(source.id)}" ${source.id === state.db.source ? "selected" : ""}>${escapeHtml(source.label)}</option>`).join("")}</select><select id="dbTable">${state.db.tables.map((table) => `<option value="${escapeHtml(table.name)}" ${table.name === state.db.table ? "selected" : ""}>${escapeHtml(table.name)} (${formatNumber(table.rows)})</option>`).join("")}</select><input id="dbSearch" value="${escapeHtml(state.db.search)}" placeholder="Поиск…" /><button id="dbSearchButton" class="secondary">Найти</button></div>${data ? genericTable(data.rows, columns) : '<div class="empty">Нет подключённых таблиц.</div>'}<div class="pagination"><span>${data ? `Строк ${formatNumber(data.total)} · страница ${data.page} из ${totalPages}` : ""}</span><div><button id="dbPrev" class="small-btn" ${!data || data.page <= 1 ? "disabled" : ""}>Назад</button><button id="dbNext" class="small-btn" ${!data || data.page >= totalPages ? "disabled" : ""}>Дальше</button></div></div></section>`;
  $("#dbSource")?.addEventListener("change", async (e) => { state.db.source = e.target.value; state.db.table = ""; state.db.page = 1; state.db.search = ""; await renderDatabase(); });
  $("#dbTable")?.addEventListener("change", async (e) => { state.db.table = e.target.value; state.db.page = 1; state.db.search = ""; await renderDatabase(); });
  const runSearch = async () => { state.db.search = $("#dbSearch").value.trim(); state.db.page = 1; await renderDatabase(); };
  $("#dbSearchButton")?.addEventListener("click", runSearch); $("#dbSearch")?.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  $("#dbPrev")?.addEventListener("click", async () => { state.db.page -= 1; await renderDatabase(); }); $("#dbNext")?.addEventListener("click", async () => { state.db.page += 1; await renderDatabase(); });
}

function renderDomainData(data, emptyText) { if (!data.sections?.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`; return `<div class="domain-sections">${data.sections.map((section) => `<article class="domain-card"><h3>${escapeHtml(section.table)}</h3><div class="domain-meta"><span>${escapeHtml(section.source_label)}</span><span>•</span><span>${formatNumber(section.count)} строк</span></div>${genericTable(section.rows)}</article>`).join("")}</div>`; }
async function renderBlockchain() { loading(); const data = await api("/api/blockchain?limit=100"); content.innerHTML = `<section class="section full"><div class="section-head"><div><h3>Solana RPC lookup</h3></div></div><div class="lookup"><select id="rpcMode"><option value="address">Адрес</option><option value="signature">Транзакция</option></select><input id="rpcValue" placeholder="Solana address или signature" /><button id="rpcButton" class="primary">Проверить</button></div><pre id="rpcResult" class="pre hidden"></pre></section><div style="height:18px"></div>${renderDomainData(data, "On-chain таблицы ещё не подключены.")}`; $("#rpcButton").addEventListener("click", async () => { const value = $("#rpcValue").value.trim(); if (!value) return; const result = $("#rpcResult"); result.classList.remove("hidden"); result.textContent = "Запрос к Solana RPC…"; try { const data = await api("/api/solana/lookup", { method: "POST", body: JSON.stringify({ value, mode: $("#rpcMode").value }) }); result.textContent = JSON.stringify(data, null, 2); } catch (error) { result.textContent = error.message; } }); }
async function renderTelegram() { loading(); const data = await api("/api/social/telegram?limit=100"); const users = data.users || []; content.innerHTML = `<div class="cards">${renderMetric("Telegram users", formatNumber(users.length))}${renderMetric("Telegram таблицы", data.sections.length)}</div><section class="domain-card"><h3>Пользователи Telegram</h3>${genericTable(users, ["source", "id", "login", "telegram_id", "telegram_username", "created_at", "last_login_at", "subscription_expires_at", "active"])}</section><div style="height:18px"></div>${renderDomainData(data, "Telegram таблицы пока не найдены.")}`; }
async function renderX() { loading(); const data = await api("/api/social/x?limit=100"); const total = Object.values(data.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0); content.innerHTML = `<div class="cards">${renderMetric("X/Twitter записей", formatNumber(total))}${renderMetric("Наборы данных", data.sections.length)}</div>${renderDomainData(data, "Таблицы X/Twitter пока не подключены.")}`; }
async function renderUsers() { loading(); const data = await api("/api/users?limit=2000"); content.innerHTML = `<div class="cards">${renderMetric("Всего найдено", formatNumber(data.total))}</div><section class="section full"><div class="section-head"><div><h3>Объединённые пользователи</h3></div></div>${genericTable(data.rows, ["source", "id", "login", "name", "telegram_id", "telegram_username", "wallet", "created_at", "last_login_at", "subscription_expires_at", "active"])}</section>`; }
async function renderLogs() { loading(); const params = new URLSearchParams({ lines: state.logs.lines, search: state.logs.search }); if (state.logs.id) params.set("log_id", state.logs.id); const data = await api(`/api/logs?${params}`); if (!state.logs.id && data.catalog[0]) { state.logs.id = data.catalog[0].id; return renderLogs(); } content.innerHTML = `<section class="section full"><div class="toolbar compact"><select id="logSource">${data.catalog.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.logs.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select><input id="logSearch" value="${escapeHtml(state.logs.search)}" placeholder="Фильтр…"/><button id="logSearchButton" class="secondary">Применить</button></div><pre class="pre log-view">${escapeHtml(data.log?.lines?.join("\n") || data.log?.error || "Лог пуст")}</pre></section>`; $("#logSource")?.addEventListener("change", async (e) => { state.logs.id = e.target.value; await renderLogs(); }); const filter = async () => { state.logs.search = $("#logSearch").value.trim(); await renderLogs(); }; $("#logSearchButton")?.addEventListener("click", filter); }
async function renderAudit() { loading(); const data = await api("/api/audit?limit=500"); content.innerHTML = `<section class="section full">${genericTable(data.rows.map((row) => ({ ...row, created_at: formatDate(row.created_at) })), ["created_at", "username", "ip_address", "action", "resource", "success", "details"])}</section>`; }
async function renderSearch() { content.innerHTML = `<section class="section full"><div class="lookup"><input id="globalQuery" placeholder="wallet, contract, username, ticker…"/><button id="globalRun" class="primary">Искать</button></div><div id="globalResults" class="empty">Введите запрос.</div></section>`; $("#globalRun").addEventListener("click", async () => { const q = $("#globalQuery").value.trim(); if (q.length < 2) return; const data = await api(`/api/search?q=${encodeURIComponent(q)}`); $("#globalResults").className = ""; $("#globalResults").innerHTML = genericTable(data.results.map((item) => ({ source: item.source_label, table: item.table, ...item.row }))); }); }
async function renderGraph() { content.innerHTML = `<section class="section full"><div class="lookup"><input id="graphQuery" placeholder="contract / wallet / user"/><button id="graphRun" class="primary">Построить</button></div><div id="graphResults" class="empty">Введите объект.</div></section>`; $("#graphRun").addEventListener("click", async () => { const q = $("#graphQuery").value.trim(); if (q.length < 2) return; const d = await api(`/api/graph?q=${encodeURIComponent(q)}`); $("#graphResults").className = ""; $("#graphResults").innerHTML = `${genericTable(d.nodes, ["id", "label", "type", "source"])}<div style="height:18px"></div>${genericTable(d.edges)}`; }); }
async function renderQueues() { loading(); const d = await api("/api/queues?limit=200"); content.innerHTML = renderDomainData(d, "Таблицы очередей пока не подключены."); }
async function renderMonitoring() { loading(); const d = await api("/api/monitoring"); content.innerHTML = `<div class="cards">${renderMetric("Uptime", Math.floor(d.runtime.uptime_seconds / 60) + " мин")}${renderMetric("Disk", d.runtime.disk.used_percent + "%")}${renderMetric("Источники online", d.sources.filter((x) => x.ok).length + " / " + d.sources.length)}</div>${genericTable([d.runtime])}`; }
async function renderControl() { loading(); const [flags, alerts, inv] = await Promise.all([api("/api/feature-flags"), api("/api/alerts?limit=200"), api("/api/inventory")]); content.innerHTML = `<section class="section full"><div class="lookup"><input id="flagName" placeholder="feature.name"/><input id="flagDescription" placeholder="Описание"/><button id="flagCreate" class="primary">Включить</button></div>${genericTable(flags.rows)}</section><div style="height:18px"></div>${genericTable(alerts.rows)}<div style="height:18px"></div>${genericTable(inv.service_manifests)}`; $("#flagCreate")?.addEventListener("click", async () => { const name = $("#flagName").value.trim(); if (!name) return; await api(`/api/feature-flags/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ name, enabled: true, description: $("#flagDescription").value.trim() }) }); toast("Feature flag сохранён"); await renderControl(); }); }

async function renderCurrentView() {
  $("#viewTitle").textContent = titles[state.view]; document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
  try { const renderers = { overview: renderOverview, database: renderDatabase, blockchain: renderBlockchain, telegram: renderTelegram, x: renderX, users: renderUsers, logs: renderLogs, search: renderSearch, graph: renderGraph, queues: renderQueues, monitoring: renderMonitoring, control: renderControl, audit: renderAudit }; await renderers[state.view]?.(); }
  catch (error) { content.innerHTML = `<div class="empty"><strong>Не удалось загрузить данные</strong><p>${escapeHtml(error.message)}</p></div>`; toast(error.message, true); }
}
async function bootstrap() { try { state.me = await api("/api/me"); showApp(); await renderCurrentView(); } catch { showLogin(); } }
$("#loginForm").addEventListener("submit", async (event) => { event.preventDefault(); $("#loginError").textContent = ""; try { await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("#loginUsername").value.trim(), password: $("#loginPassword").value }) }); state.me = await api("/api/me"); $("#loginPassword").value = ""; showApp(); await renderCurrentView(); } catch (error) { $("#loginError").textContent = error.message; } });
$("#logoutButton").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST" }); } catch {} state.me = null; showLogin(); });
$("#navigation").addEventListener("click", async (event) => { const button = event.target.closest("[data-view]"); if (!button) return; state.view = button.dataset.view; await renderCurrentView(); });
$("#refreshButton").addEventListener("click", renderCurrentView);
setInterval(() => { $("#systemClock").textContent = new Date().toLocaleString("ru-RU"); }, 1000);
bootstrap();
