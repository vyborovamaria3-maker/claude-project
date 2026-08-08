(() => {
  const nativeFetch = window.fetch.bind(window);
  let pendingMfa = null;
  let pendingReauth = null;

  function modal(kind) {
    const id = kind === "mfa" ? "adminMfaModal" : "adminReauthModal";
    let root = document.getElementById(id);
    if (root) return root;
    root = document.createElement("div");
    root.id = id;
    root.className = "admin-security-modal hidden";
    const reauth = kind === "reauth";
    root.innerHTML = `
      <section class="admin-security-dialog" role="dialog" aria-modal="true">
        <p class="admin-security-kicker">SECURITY CHECK</p>
        <h3>${reauth ? "Повторное подтверждение" : "Двухфакторная проверка"}</h3>
        <p class="admin-security-copy">${reauth ? "Для опасного действия подтвердите пароль и одноразовый код." : "Введите 6-значный код из приложения-аутентификатора."}</p>
        ${reauth ? '<label>Пароль<input id="adminSecurityPassword" type="password" autocomplete="current-password"></label>' : ""}
        <label>TOTP-код<input id="adminSecurityCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
        <div id="adminSecurityError" class="admin-security-error"></div>
        <div class="admin-security-actions"><button type="button" class="secondary" data-sec-cancel>Отмена</button><button type="button" class="primary" data-sec-submit>Подтвердить</button></div>
      </section>`;
    document.body.appendChild(root);
    return root;
  }

  function ask(kind) {
    const active = kind === "mfa" ? pendingMfa : pendingReauth;
    if (active) return active;
    const root = modal(kind);
    const code = root.querySelector("#adminSecurityCode");
    const password = root.querySelector("#adminSecurityPassword");
    const error = root.querySelector("#adminSecurityError");
    error.textContent = "";
    code.value = "";
    if (password) password.value = "";
    root.classList.remove("hidden");
    (password || code).focus();
    const promise = new Promise((resolve) => {
      const finish = (value) => {
        root.classList.add("hidden");
        root.querySelector("[data-sec-submit]").onclick = null;
        root.querySelector("[data-sec-cancel]").onclick = null;
        if (kind === "mfa") pendingMfa = null; else pendingReauth = null;
        resolve(value);
      };
      root.querySelector("[data-sec-cancel]").onclick = () => finish(null);
      root.querySelector("[data-sec-submit]").onclick = () => {
        const value = { code: code.value.trim(), password: password?.value || "" };
        if (!/^\d{6}$/.test(value.code)) { error.textContent = "Введите 6 цифр из приложения-аутентификатора."; return; }
        if (kind === "reauth" && !value.password) { error.textContent = "Введите пароль администратора."; return; }
        finish(value);
      };
    });
    if (kind === "mfa") pendingMfa = promise; else pendingReauth = promise;
    return promise;
  }

  async function securityPost(path, body) {
    const response = await nativeFetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try { detail = (await response.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    return response;
  }

  async function satisfyMfa() {
    while (true) {
      const value = await ask("mfa");
      if (!value) return false;
      try { await securityPost("/api/security/mfa/verify", { code: value.code }); return true; }
      catch (error) {
        const root = modal("mfa"); root.classList.remove("hidden"); root.querySelector("#adminSecurityError").textContent = error.message;
        root.classList.add("hidden");
        window.alert("MFA: " + error.message);
      }
    }
  }

  async function satisfyReauth() {
    while (true) {
      const value = await ask("reauth");
      if (!value) return false;
      try { await securityPost("/api/security/reauth", { password: value.password, code: value.code }); return true; }
      catch (error) { window.alert("Re-auth: " + error.message); }
    }
  }

  function cleanInit(init = {}) {
    const next = { ...init };
    delete next.__adminSecurityRetry;
    return next;
  }

  window.fetch = async function adminSecurityFetch(input, init = {}) {
    const response = await nativeFetch(input, cleanInit(init));
    if (response.status !== 428 || init.__adminSecurityRetry) return response;
    const url = typeof input === "string" ? input : String(input?.url || "");
    if (url.includes("/api/security/")) return response;
    let body = {};
    try { body = await response.clone().json(); } catch {}
    let satisfied = false;
    if (body.code === "mfa_required") satisfied = await satisfyMfa();
    else if (body.code === "reauth_required") satisfied = await satisfyReauth();
    if (!satisfied) return response;
    return nativeFetch(input, { ...cleanInit(init), __adminSecurityRetry: true });
  };

  window.AdminSecurity = Object.freeze({ satisfyMfa, satisfyReauth });
})();
