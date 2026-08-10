"use client";

import { useEffect } from "react";
import { LANDING_BODY, LANDING_CSS } from "@/components/landing/landingContent";

type AuthResponse = {
  access_token?: string;
  expires_in?: number;
  redirect_url?: string;
  detail?: string;
};

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;
const AUTH_ENDPOINT = "/api/v1/auth/login-password";

function mapLoginError(status: number, detail?: string) {
  if (status === 401) return "Неверный логин или пароль.";
  if (status === 403) return "Срок подписки истёк. Продлите доступ через Telegram.";
  if (status === 422) return "Проверьте формат логина или пароля.";
  if (status === 429) return "Слишком много попыток. Подождите минуту и попробуйте снова.";
  if (status === 503) return "Сервис авторизации недоступен. Проверьте, что backend запущен.";
  return detail || "Не удалось выполнить вход. Попробуйте ещё раз.";
}

export default function PublicLandingPage() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const timers: number[] = [];
    const abortController = new AbortController();

    const listen = (
      target: EventTarget,
      event: string,
      handler: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      target.addEventListener(event, handler, options);
      cleanups.push(() => target.removeEventListener(event, handler, options));
    };

    const listenElement = (
      target: Element,
      event: string,
      handler: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      target.addEventListener(event, handler, options);
      cleanups.push(() => target.removeEventListener(event, handler, options));
    };

    const toggle = document.getElementById("menuToggle") as HTMLButtonElement | null;
    const menu = document.getElementById("mobileMenu") as HTMLElement | null;

    const setMenu = (open: boolean) => {
      if (!toggle || !menu) return;
      menu.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
      menu.setAttribute("aria-hidden", String(!open));
    };

    if (toggle && menu) {
      listenElement(toggle, "click", () => setMenu(!menu.classList.contains("open")));

      menu.querySelectorAll("a").forEach((anchor) => {
        listenElement(anchor, "click", () => setMenu(false));
      });

      listen(document, "click", ((event: MouseEvent) => {
        const target = event.target as Node | null;
        if (
          target &&
          menu.classList.contains("open") &&
          !menu.contains(target) &&
          !toggle.contains(target)
        ) {
          setMenu(false);
        }
      }) as EventListener);

      listen(window, "resize", () => {
        if (window.innerWidth > 1100) setMenu(false);
      }, { passive: true });
    }

    const syncVisualViewportHeight = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--visual-viewport-height", `${height}px`);
    };

    syncVisualViewportHeight();
    listen(window, "resize", syncVisualViewportHeight, { passive: true });

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncVisualViewportHeight, { passive: true });
      cleanups.push(() => window.visualViewport?.removeEventListener("resize", syncVisualViewportHeight));
    }

    const year = document.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12 },
    );

    document.querySelectorAll(".reveal:not(.visible)").forEach((element) => observer.observe(element));
    cleanups.push(() => observer.disconnect());

    const loginModal = document.getElementById("login") as HTMLElement | null;
    const loginForm = document.getElementById("platformLoginForm") as HTMLFormElement | null;
    const loginInput = document.getElementById("loginInput") as HTMLInputElement | null;
    const passwordInput = document.getElementById("passwordInput") as HTMLInputElement | null;
    const passwordToggle = document.getElementById("passwordToggle") as HTMLButtonElement | null;
    const passwordEyeUse = document.getElementById("passwordEyeUse") as SVGUseElement | null;
    const loginAlert = document.getElementById("loginAlert") as HTMLElement | null;
    const loginSubmit = document.getElementById("loginSubmit") as HTMLButtonElement | null;
    const initialSubmitMarkup = loginSubmit?.innerHTML ?? "";
    let lastFocusedElement: HTMLElement | null = null;

    const clearAlert = () => {
      if (!loginAlert) return;
      loginAlert.className = "login-alert";
      loginAlert.textContent = "";
    };

    const showAlert = (message: string, type: "error" | "success" = "error") => {
      if (!loginAlert) return;
      loginAlert.className = `login-alert show${type === "success" ? " success" : ""}`;
      const iconId = type === "success" ? "check" : "alert";
      loginAlert.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg><span></span>`;
      const messageElement = loginAlert.querySelector("span");
      if (messageElement) messageElement.textContent = message;
    };

    const validateLogin = () => {
      if (!loginInput) return false;
      const isValid = LOGIN_RE.test(loginInput.value.trim());
      loginInput.setAttribute("aria-invalid", String(!isValid));
      return isValid;
    };

    const validatePassword = () => {
      if (!passwordInput) return false;
      const isValid = passwordInput.value.length === 32;
      passwordInput.setAttribute("aria-invalid", String(!isValid));
      return isValid;
    };

    const openLogin = (event?: Event) => {
      event?.preventDefault();
      if (!loginModal || !loginInput) return;

      lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      loginModal.classList.add("open");
      loginModal.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");

      if (window.location.hash !== "#login") {
        window.history.pushState(null, "", "#login");
      }

      const timer = window.setTimeout(() => loginInput.focus(), 80);
      timers.push(timer);
    };

    const closeLogin = (event?: Event) => {
      event?.preventDefault();
      if (!loginModal) return;

      loginModal.classList.remove("open");
      loginModal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");

      if (window.location.hash === "#login") {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }

      lastFocusedElement?.focus();
    };

    document.querySelectorAll("[data-open-login]").forEach((button) => {
      listenElement(button, "click", openLogin);
    });

    document.querySelectorAll("[data-close-login]").forEach((button) => {
      listenElement(button, "click", closeLogin);
    });

    listen(window, "hashchange", () => {
      if (window.location.hash === "#login") openLogin();
      else if (loginModal?.classList.contains("open")) closeLogin();
    });

    listen(document, "keydown", ((event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      if (loginModal?.classList.contains("open")) {
        closeLogin(event);
      } else if (menu?.classList.contains("open")) {
        setMenu(false);
        toggle?.focus();
      }
    }) as EventListener);

    if (window.location.hash === "#login") openLogin();

    if (passwordToggle && passwordInput && passwordEyeUse) {
      listenElement(passwordToggle, "click", () => {
        const isVisible = passwordInput.type === "text";
        passwordInput.type = isVisible ? "password" : "text";
        passwordToggle.setAttribute("aria-pressed", String(!isVisible));
        passwordToggle.setAttribute("aria-label", isVisible ? "Показать пароль" : "Скрыть пароль");
        passwordEyeUse.setAttribute("href", isVisible ? "#eye" : "#eye-off");
        passwordInput.focus();
      });
    }

    if (loginInput) {
      listenElement(loginInput, "input", () => {
        clearAlert();
        validateLogin();
      });
    }

    if (passwordInput) {
      listenElement(passwordInput, "input", () => {
        clearAlert();
        validatePassword();
      });
    }

    if (loginForm && loginInput && passwordInput && loginSubmit) {
      listenElement(loginForm, "submit", (event) => {
        event.preventDefault();
        clearAlert();

        const loginOk = validateLogin();
        const passwordOk = validatePassword();

        if (!loginOk || !passwordOk) {
          showAlert("Исправьте выделенные поля и повторите вход.");
          (loginOk ? passwordInput : loginInput).focus();
          return;
        }

        loginSubmit.disabled = true;
        loginSubmit.innerHTML = '<span class="login-spinner" aria-hidden="true"></span><span>Проверяем доступ…</span>';

        void (async () => {
          try {
            const response = await fetch(AUTH_ENDPOINT, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                login: loginInput.value.trim(),
                password: passwordInput.value.toUpperCase(),
              }),
              signal: abortController.signal,
            });

            const raw = await response.text();
            let data: AuthResponse = {};

            try {
              data = raw ? (JSON.parse(raw) as AuthResponse) : {};
            } catch {
              data = { detail: raw };
            }

            if (!response.ok) {
              throw new Error(mapLoginError(response.status, data.detail));
            }

            if (!data.access_token) {
              throw new Error("Сервер не вернул токен доступа.");
            }

            window.localStorage.setItem("potapoff.access_token", data.access_token);
            window.localStorage.setItem(
              "potapoff.auth_meta",
              JSON.stringify({
                access_token: data.access_token,
                expires_in: data.expires_in || 86400,
                saved_at: Date.now(),
              }),
            );

            showAlert("Вход выполнен. Открываем рабочую панель…", "success");
            loginSubmit.innerHTML = '<svg class="icon"><use href="#check"/></svg><span>Доступ подтверждён</span>';

            const timer = window.setTimeout(() => {
              window.location.assign(data.redirect_url || "/dashboard");
            }, 700);
            timers.push(timer);
          } catch (error) {
            if (abortController.signal.aborted) return;

            const message =
              error instanceof TypeError
                ? "Не удалось связаться с API авторизации."
                : error instanceof Error
                  ? error.message
                  : "Ошибка входа.";

            showAlert(message);
            loginSubmit.disabled = false;
            loginSubmit.innerHTML = initialSubmitMarkup;
          }
        })();
      });
    }

    return () => {
      abortController.abort();
      observer.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
      cleanups.reverse().forEach((cleanup) => cleanup());
      document.body.classList.remove("modal-open");
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />
      <div className="potapoff-landing" dangerouslySetInnerHTML={{ __html: LANDING_BODY }} />
    </>
  );
}
