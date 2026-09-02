(() => {
  const nav = document.querySelector("#subscriptionNav");
  const navigation = document.querySelector("#navigation");
  const refreshButton = document.querySelector("#refreshButton");
  const content = document.querySelector("#content");
  const title = document.querySelector("#viewTitle");
  if (!nav || !navigation || !refreshButton || !content || !title) return;

  let active = false;

  function notify(message, isError = false) {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show${isError ? " error" : ""}`;
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => {
      toast.className = "toast";
    }, 3200);
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });

    if (response.status === 401) {
      document.querySelector("#appView")?.classList.add("hidden");
      document.querySelector("#loginView")?.classList.remove("hidden");
      throw new Error("Требуется вход");
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const detail = body?.detail;
      const message = Array.isArray(detail)
        ? detail.map((item) => item?.msg || "Некорректное значение").join("; ")
        : detail || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body || {};
  }

  function setModeSummary(data) {
    const mode = document.querySelector("#subscriptionMode");
    const hint = document.querySelector("#subscriptionModeHint");
    if (!mode || !hint) return;

    const sol = Number(data.monthly_price_sol || 0);
    const usdt = Number(data.monthly_price_usdt || 0);
    const walletReady = Boolean((data.solana_recipient_wallet || "").trim());

    if (data.free_demo_enabled) {
      mode.textContent = "TEST MODE";
      mode.className = "subscription-mode test";
      hint.textContent = `Бесплатный доступ на ${data.demo_days} дн. Платная активация временно отключена.`;
      return;
    }

    mode.textContent = "PAID MODE";
    mode.className = "subscription-mode paid";
    if (!walletReady) {
      hint.textContent = "Укажите публичный Solana-кошелёк, иначе платёжные кнопки будут недоступны.";
    } else if (sol <= 0 && usdt <= 0) {
      hint.textContent = "Укажите цену SOL и/или USDT, чтобы включить платную активацию.";
    } else {
      hint.textContent = "Платная активация настроена. TEST выключен.";
    }
  }

  function populate(data) {
    document.querySelector("#subscriptionSol").value = data.monthly_price_sol ?? "0";
    document.querySelector("#subscriptionUsdt").value = data.monthly_price_usdt ?? "0";
    document.querySelector("#subscriptionDemoEnabled").checked = Boolean(data.free_demo_enabled);
    document.querySelector("#subscriptionDemoDays").value = data.demo_days ?? 30;
    document.querySelector("#subscriptionWallet").value = data.solana_recipient_wallet || "";
    setModeSummary(data);
  }

  async function render() {
    active = true;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    nav.classList.add("active");
    title.textContent = "Подписка / Mini App";

    content.innerHTML = `
      <div class="subscription-headline">
        <div>
          <p class="eyebrow">TELEGRAM MINI APP / ACCESS CONTROL</p>
          <h3>Настройки подписки</h3>
          <p class="muted">Одна панель для цен, TEST-режима и кошелька получателя. Изменения применяются к тем же настройкам, которые использует Mini App.</p>
        </div>
        <div>
          <div id="subscriptionMode" class="subscription-mode">Загрузка…</div>
          <p id="subscriptionModeHint" class="subscription-mode-hint"></p>
        </div>
      </div>

      <form id="subscriptionForm" class="subscription-form">
        <section class="section">
          <div class="section-head">
            <div>
              <h3>Оплата</h3>
              <p>Месячная стоимость доступа. Можно включить только одну валюту.</p>
            </div>
          </div>
          <div class="subscription-grid two">
            <label>
              Цена за месяц, SOL
              <input id="subscriptionSol" type="number" min="0" step="0.000000001" inputmode="decimal" required />
              <small>0 = кнопка SOL отключена</small>
            </label>
            <label>
              Цена за месяц, USDT
              <input id="subscriptionUsdt" type="number" min="0" step="0.000001" inputmode="decimal" required />
              <small>0 = кнопка USDT отключена</small>
            </label>
          </div>
          <label class="subscription-wallet">
            Публичный Solana-кошелёк для получения оплаты
            <input id="subscriptionWallet" maxlength="64" autocomplete="off" placeholder="Solana public address" />
            <small>Только публичный адрес. Seed/private key здесь никогда не нужен.</small>
          </label>
        </section>

        <section class="section">
          <div class="section-head">
            <div>
              <h3>TEST-режим</h3>
              <p>При включении пользователь получает бесплатный доступ без оплаты.</p>
            </div>
          </div>
          <label class="subscription-toggle-row">
            <span>
              <strong>Бесплатный TEST</strong>
              <small>Платные SOL/USDT checkout будут отключены, пока TEST включён.</small>
            </span>
            <input id="subscriptionDemoEnabled" type="checkbox" />
          </label>
          <label>
            Срок тестового доступа, дней
            <input id="subscriptionDemoDays" type="number" min="1" max="3650" step="1" required />
          </label>
        </section>

        <div class="subscription-actions">
          <span id="subscriptionSaveStatus" class="muted"></span>
          <button id="subscriptionSave" class="primary" type="submit">Сохранить настройки</button>
        </div>
      </form>`;

    const form = document.querySelector("#subscriptionForm");
    const saveButton = document.querySelector("#subscriptionSave");
    const saveStatus = document.querySelector("#subscriptionSaveStatus");

    try {
      const data = await request("/api/subscription-settings");
      populate(data);
    } catch (error) {
      content.innerHTML = `<div class="empty"><strong>Не удалось загрузить настройки подписки</strong><p></p></div>`;
      const paragraph = content.querySelector("p");
      if (paragraph) paragraph.textContent = error.message;
      notify(error.message, true);
      return;
    }

    document.querySelector("#subscriptionDemoEnabled")?.addEventListener("change", () => {
      const preview = {
        monthly_price_sol: document.querySelector("#subscriptionSol").value,
        monthly_price_usdt: document.querySelector("#subscriptionUsdt").value,
        free_demo_enabled: document.querySelector("#subscriptionDemoEnabled").checked,
        demo_days: Number(document.querySelector("#subscriptionDemoDays").value || 30),
        solana_recipient_wallet: document.querySelector("#subscriptionWallet").value,
      };
      setModeSummary(preview);
    });

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      saveButton.disabled = true;
      saveStatus.textContent = "Сохраняем…";

      const payload = {
        monthly_price_sol: document.querySelector("#subscriptionSol").value || "0",
        monthly_price_usdt: document.querySelector("#subscriptionUsdt").value || "0",
        free_demo_enabled: document.querySelector("#subscriptionDemoEnabled").checked,
        demo_days: Number(document.querySelector("#subscriptionDemoDays").value),
        solana_recipient_wallet: document.querySelector("#subscriptionWallet").value.trim(),
      };

      try {
        const updated = await request("/api/subscription-settings", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        populate(updated);
        saveStatus.textContent = "Сохранено";
        notify("Настройки Mini App сохранены");
      } catch (error) {
        saveStatus.textContent = "Ошибка сохранения";
        notify(error.message, true);
      } finally {
        saveButton.disabled = false;
      }
    });
  }

  nav.addEventListener("click", (event) => {
    event.preventDefault();
    void render();
  });

  navigation.addEventListener("click", (event) => {
    if (event.target.closest("[data-view]")) active = false;
  });

  refreshButton.addEventListener(
    "click",
    (event) => {
      if (!active) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void render();
    },
    true,
  );
})();
