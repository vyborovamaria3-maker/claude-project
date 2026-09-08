(() => {
  const state = { active: false, data: null };

  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function toast(message, error = false) {
    const node = document.getElementById("toast");
    if (!node) return;
    node.textContent = message;
    node.classList.add("show");
    if (error) node.classList.add("error"); else node.classList.remove("error");
    window.setTimeout(() => node.classList.remove("show"), 3200);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
    return payload;
  }

  function activateNav() {
    document.querySelectorAll("#navigation .nav-item").forEach((item) => item.classList.remove("active"));
    document.getElementById("integrationsNav")?.classList.add("active");
    const title = document.getElementById("viewTitle");
    if (title) title.textContent = "Интеграции / API Keys";
  }

  function loading() {
    const content = document.getElementById("content");
    if (!content) return;
    content.innerHTML = '<div class="loading"><span></span><p>Загрузка интеграций…</p></div>';
  }

  function heliusRows(keys) {
    if (!keys.length) return '<div class="integration-empty">Ключей пока нет. Добавь основной Helius API key выше.</div>';
    return keys.map((key) => {
      const meta = key.metadata || {};
      const tested = meta.last_test_at
        ? `${meta.last_test_ok ? "OK" : "ERROR"} · ${esc(meta.last_test_at)}${meta.last_test_latency_ms ? ` · ${esc(meta.last_test_latency_ms)} ms` : ""}`
        : "ещё не проверялся";
      return `<div class="integration-row" data-helius-id="${esc(key.id)}">
        <div><div class="integration-row-title">${esc(key.name)}</div><div class="integration-row-meta">${key.enabled ? "активен" : "отключён"} · ${tested}</div></div>
        <div class="integration-mask">${esc(key.masked)}</div>
        <div class="integration-actions">
          <button class="secondary" data-action="test-helius">Проверить</button>
          <button class="secondary" data-action="toggle-helius" data-enabled="${key.enabled ? "1" : "0"}">${key.enabled ? "Отключить" : "Включить"}</button>
          <button class="secondary danger-subtle" data-action="delete-helius">Удалить</button>
        </div>
      </div>`;
    }).join("");
  }

  function secretState(label, row, configuredText) {
    return `<div class="integration-secret-state"><div><strong>${esc(label)}</strong><div><span>${row ? esc(row.masked) : "не задан"}</span></div></div><span>${row ? configuredText : "отсутствует"}</span></div>`;
  }

  function render() {
    const content = document.getElementById("content");
    if (!content || !state.data) return;
    const data = state.data;
    const disabled = data.secret_storage_configured ? "" : "disabled";
    const tg = data.telegram || {};
    content.innerHTML = `<div class="integrations-shell">
      <section class="integrations-hero">
        <div><p class="eyebrow">SECURE RUNTIME CONFIG</p><h3>Интеграции</h3><p class="muted">Управление Helius и Telegram MTProto без записи provider-секретов в Git.</p></div>
        <span class="integration-status ${data.secret_storage_configured ? "ok" : "warn"}">${data.secret_storage_configured ? "Encrypted store: READY" : "Encrypted store: NOT CONFIGURED"}</span>
      </section>
      ${data.secret_storage_configured ? "" : '<div class="integration-callout">На сервере нужно один раз задать <span class="mono">ADMIN_SECRETS_MASTER_KEY</span>. Пока он отсутствует, добавление секретов отключено.</div>'}
      <div class="integration-grid">
        <section class="integration-card">
          <div class="integration-card-head"><div><p class="eyebrow">BLOCKCHAIN</p><h3>Helius API Keys</h3></div><span class="integration-status ${(data.helius?.keys || []).some((k) => k.enabled) ? "ok" : "warn"}">${(data.helius?.keys || []).filter((k) => k.enabled).length} active</span></div>
          <form id="heliusKeyForm" class="integration-form two">
            <label>Название<input name="name" maxlength="80" placeholder="Main Helius" ${disabled}></label>
            <label>API key<input name="api_key" type="password" autocomplete="new-password" placeholder="Вставь Helius API key" required ${disabled}></label>
            <button class="primary" type="submit" ${disabled}>Добавить</button>
          </form>
          <div class="integration-list">${heliusRows(data.helius?.keys || [])}</div>
        </section>
        <section class="integration-card">
          <div class="integration-card-head"><div><p class="eyebrow">SOCIAL INTELLIGENCE</p><h3>Telegram MTProto</h3></div><span class="integration-status ${tg.credentials_configured && tg.session_configured ? "ok" : "warn"}">${tg.credentials_configured && tg.session_configured ? "READY" : "SETUP REQUIRED"}</span></div>
          <div class="integration-secret-block">
            ${secretState("API ID", tg.api_id, "сохранён")}
            ${secretState("API HASH", tg.api_hash, "зашифрован")}
          </div>
          <form id="telegramCredentialsForm" class="integration-form">
            <label>API ID<input name="api_id" inputmode="numeric" autocomplete="off" placeholder="12345678" required ${disabled}></label>
            <label>API HASH<input name="api_hash" type="password" autocomplete="new-password" placeholder="Telegram API hash" required ${disabled}></label>
            <div class="integration-actions"><button class="primary" type="submit" ${disabled}>Сохранить credentials</button><button id="deleteTelegramCredentials" class="secondary danger-subtle" type="button" ${disabled}>Удалить credentials</button></div>
          </form>
          <div class="integration-secret-block">${secretState("TG_SESSION_STRING", tg.session_string, "зашифрована")}</div>
          <form id="telegramSessionForm" class="integration-form">
            <label>Session String<input name="session_string" type="password" autocomplete="new-password" placeholder="Вставь Telethon StringSession" required ${disabled}></label>
            <div class="integration-actions"><button class="primary" type="submit" ${disabled}>Сохранить session</button><button id="deleteTelegramSession" class="secondary danger-subtle" type="button" ${disabled}>Удалить session</button></div>
          </form>
          <div class="integration-callout">Полные значения после сохранения обратно в браузер не возвращаются. Для MTProto нужны API ID + API HASH + авторизованная Session String.</div>
        </section>
      </div>
    </div>`;
    bindActions();
  }

  async function load() {
    state.active = true;
    activateNav();
    loading();
    try {
      state.data = await api("/api/integrations");
      if (state.active) render();
    } catch (error) {
      const content = document.getElementById("content");
      if (content) content.innerHTML = `<div class="integration-callout">Не удалось загрузить интеграции: ${esc(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  function bindActions() {
    const heliusForm = document.getElementById("heliusKeyForm");
    heliusForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(heliusForm);
      try {
        await api("/api/integrations/helius/keys", { method: "POST", body: JSON.stringify({ name: String(form.get("name") || "Helius API key"), api_key: String(form.get("api_key") || "") }) });
        heliusForm.reset(); toast("Helius key добавлен"); await load();
      } catch (error) { toast(error.message, true); }
    });

    document.querySelectorAll("[data-helius-id]").forEach((row) => {
      row.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const id = row.getAttribute("data-helius-id");
        try {
          if (button.dataset.action === "test-helius") {
            const result = await api(`/api/integrations/helius/keys/${encodeURIComponent(id)}/test`, { method: "POST" });
            toast(result.ok ? `Helius OK · ${result.latency_ms} ms` : (result.error || "Helius check failed"), !result.ok);
          } else if (button.dataset.action === "toggle-helius") {
            const enabled = button.dataset.enabled !== "1";
            await api(`/api/integrations/helius/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
            toast(enabled ? "Helius key включён" : "Helius key отключён");
          } else if (button.dataset.action === "delete-helius") {
            if (!window.confirm("Удалить этот Helius API key?")) return;
            await api(`/api/integrations/helius/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
            toast("Helius key удалён");
          }
          await load();
        } catch (error) { toast(error.message, true); }
      });
    });

    const credentialsForm = document.getElementById("telegramCredentialsForm");
    credentialsForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(credentialsForm);
      try {
        await api("/api/integrations/telegram/credentials", { method: "PUT", body: JSON.stringify({ api_id: Number(form.get("api_id")), api_hash: String(form.get("api_hash") || "") }) });
        credentialsForm.reset(); toast("Telegram API credentials сохранены"); await load();
      } catch (error) { toast(error.message, true); }
    });

    document.getElementById("deleteTelegramCredentials")?.addEventListener("click", async () => {
      if (!window.confirm("Удалить Telegram API ID и API HASH?")) return;
      try { await api("/api/integrations/telegram/credentials", { method: "DELETE" }); toast("Telegram credentials удалены"); await load(); } catch (error) { toast(error.message, true); }
    });

    const sessionForm = document.getElementById("telegramSessionForm");
    sessionForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(sessionForm);
      try {
        await api("/api/integrations/telegram/session", { method: "PUT", body: JSON.stringify({ session_string: String(form.get("session_string") || "") }) });
        sessionForm.reset(); toast("Telegram session сохранена"); await load();
      } catch (error) { toast(error.message, true); }
    });

    document.getElementById("deleteTelegramSession")?.addEventListener("click", async () => {
      if (!window.confirm("Удалить Telegram Session String?")) return;
      try { await api("/api/integrations/telegram/session", { method: "DELETE" }); toast("Telegram session удалена"); await load(); } catch (error) { toast(error.message, true); }
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    const nav = document.getElementById("integrationsNav");
    nav?.addEventListener("click", (event) => { event.preventDefault(); load(); });
    document.getElementById("navigation")?.addEventListener("click", (event) => {
      const button = event.target.closest("button.nav-item");
      if (button && button.id !== "integrationsNav") state.active = false;
    }, true);
    document.getElementById("refreshButton")?.addEventListener("click", (event) => {
      if (!state.active) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      load();
    }, true);
  });
})();
