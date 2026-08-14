"use client";

import { useEffect } from "react";
import { LANDING_BODY, LANDING_CSS } from "@/components/landing/landingContent";

type ChartPoint = { time: number; price: number };
type ChartRange = "5M" | "15M" | "30M" | "1H" | "4H" | "1D";

const RANGE_MS: Record<ChartRange, number> = {
  "5M": 5 * 60_000,
  "15M": 15 * 60_000,
  "30M": 30 * 60_000,
  "1H": 60 * 60_000,
  "4H": 4 * 60 * 60_000,
  "1D": 24 * 60 * 60_000,
};

const RANGE_VALUES: ChartRange[] = ["5M", "15M", "30M", "1H", "4H", "1D"];

function getAuthEndpoint() {
  const queryApi = new URLSearchParams(window.location.search).get("api");
  const configuredApi = queryApi || document.documentElement.dataset.apiBase || "";
  return configuredApi
    ? `${configuredApi.replace(/\/$/, "")}/api/v1/auth/login-password`
    : "/api/v1/auth/login-password";
}

function mapLoginError(status: number, detail?: string) {
  if (status === 401) return "Неверный логин или пароль.";
  if (status === 403) return "Срок подписки истёк. Продлите доступ через Telegram.";
  if (status === 422) return "Проверьте формат логина и пароля.";
  if (status === 429) return "Слишком много попыток. Попробуйте немного позже.";
  if (status === 503) return "Сервис авторизации временно недоступен.";
  return detail || "Не удалось выполнить вход.";
}

function normalizeRows(rows: ChartPoint[]) {
  const map = new Map<number, number>();
  for (const point of rows) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.price) || point.price <= 0) continue;
    map.set(point.time, point.price);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, price]) => ({ time, price }));
}

function usd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function setText(id: string, value: string) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function drawChart(points: ChartPoint[], range: ChartRange) {
  const line = document.getElementById("line");
  const glow = document.getElementById("glow");
  const area = document.getElementById("area");
  const dot = document.getElementById("lastDot") as HTMLElement | null;
  if (!line || !glow || !area || !dot || points.length < 2) return;

  const prices = points.map((point) => point.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const spread = Math.max(high - low, high * 0.0015, 0.01);
  const paddedLow = low - spread * 0.11;
  const paddedHigh = high + spread * 0.11;
  const firstTime = points[0].time;
  const lastTime = points[points.length - 1].time;
  const timeSpan = Math.max(lastTime - firstTime, 1);

  const coords = points.map((point) => {
    const x = 14 + ((point.time - firstTime) / timeSpan) * 952;
    const y = 18 + ((paddedHigh - point.price) / (paddedHigh - paddedLow)) * 272;
    return [x, y] as const;
  });

  const d = coords
    .map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");

  line.setAttribute("d", d);
  glow.setAttribute("d", d);
  area.setAttribute("d", `${d} L966 305 L14 305 Z`);

  const [lastX, lastY] = coords[coords.length - 1];
  dot.style.left = `${(lastX / 980) * 100}%`;
  dot.style.top = `${(lastY / 315) * 100}%`;

  const latest = points[points.length - 1].price;
  const first = points[0].price;
  const change = ((latest - first) / first) * 100;
  const changeText = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

  setText("price", usd(latest));
  setText("highMetric", usd(high));
  setText("lowMetric", usd(low));
  setText("change", changeText);
  setText("changeMetric", changeText);
  setText("floatLow", usd(low));
  setText("rangeMetric", range);
}

export default function PublicLandingPage() {
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    let destroyed = false;

    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      target.addEventListener(type, listener, options);
      cleanups.push(() => target.removeEventListener(type, listener, options));
    };

    // Theme switch: Normal <-> Gold with persistence.
    const themeButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"),
    );

    const applyTheme = (theme: "solana" | "gold") => {
      const gold = theme === "gold";
      document.body.classList.toggle("gold-theme-preview", gold);
      document.body.dataset.landingTheme = theme;
      document.documentElement.dataset.landingTheme = theme;
      themeButtons.forEach((button) => {
        const active = button.dataset.themeChoice === theme;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      try {
        window.localStorage.setItem("potapoff-landing-theme", theme);
      } catch {}
    };

    let savedTheme: "solana" | "gold" = "solana";
    try {
      savedTheme =
        window.localStorage.getItem("potapoff-landing-theme") === "gold"
          ? "gold"
          : "solana";
    } catch {}
    applyTheme(savedTheme);

    themeButtons.forEach((button) => {
      listen(button, "click", () =>
        applyTheme(button.dataset.themeChoice === "gold" ? "gold" : "solana"),
      );
    });

    // Login modal.
    const modal = document.getElementById("loginModal");
    const closeButton = modal?.querySelector<HTMLAnchorElement>(".close");
    const loginInput = document.getElementById("prodLoginInput") as HTMLInputElement | null;
    const passwordInput = document.getElementById("prodPasswordInput") as HTMLInputElement | null;
    const submitButton = document.getElementById("prodLoginSubmit") as HTMLButtonElement | null;
    const loginStatus = document.getElementById("prodLoginStatus");

    const showLoginStatus = (text: string, type: "error" | "success") => {
      if (!loginStatus) return;
      loginStatus.textContent = text;
      loginStatus.className = `login-status show ${type}`;
    };

    const clearLoginStatus = () => {
      if (!loginStatus) return;
      loginStatus.textContent = "";
      loginStatus.className = "login-status";
    };

    const focusLoginWhenOpened = () => {
      if (window.location.hash === "#loginModal") {
        window.setTimeout(() => loginInput?.focus(), 60);
      }
    };

    listen(window, "hashchange", focusLoginWhenOpened);
    focusLoginWhenOpened();

    if (closeButton) {
      listen(closeButton, "click", () => clearLoginStatus());
    }

    const submitLogin = async () => {
      if (!loginInput || !passwordInput || !submitButton) return;

      clearLoginStatus();
      const login = loginInput.value.trim();
      const password = passwordInput.value;

      if (!/^[A-Za-z0-9_]{4,32}$/.test(login)) {
        showLoginStatus("Логин: 4–32 символа, латиница, цифры и _.", "error");
        loginInput.focus();
        return;
      }

      if (password.length !== 32) {
        showLoginStatus("Пароль должен содержать 32 символа.", "error");
        passwordInput.focus();
        return;
      }

      const original = submitButton.innerHTML;
      submitButton.disabled = true;
      submitButton.textContent = "Проверяем доступ…";

      try {
        const response = await fetch(getAuthEndpoint(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            login,
            password: password.toUpperCase(),
          }),
        });

        const raw = await response.text();
        let data: {
          detail?: string;
          access_token?: string;
          expires_in?: number;
          redirect_url?: string;
        } = {};

        try {
          data = raw ? JSON.parse(raw) : {};
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

        showLoginStatus("Доступ подтверждён. Открываем рабочую панель…", "success");
        submitButton.textContent = "Доступ подтверждён";

        window.setTimeout(() => {
          window.location.assign(data.redirect_url || "/dashboard");
        }, 500);
      } catch (error) {
        showLoginStatus(
          error instanceof Error ? error.message : "Ошибка входа.",
          "error",
        );
        submitButton.disabled = false;
        submitButton.innerHTML = original;
      }
    };

    if (submitButton) listen(submitButton, "click", () => void submitLogin());

    [loginInput, passwordInput].forEach((input) => {
      if (!input) return;
      listen(input, "input", clearLoginStatus);
      listen(input, "keydown", ((event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submitLogin();
        }
      }) as EventListener);
    });

    // Real SOL/USD ranges: 5M / 15M / 30M / 1H / 4H / 1D.
    let minutePoints: ChartPoint[] = [];
    let dayPoints: ChartPoint[] = [];
    let currentRange: ChartRange = "5M";
    const marketError = document.getElementById("marketDataError");

    const setMarketError = (show: boolean) => {
      marketError?.classList.toggle("show", show);
    };

    const renderRange = (range: ChartRange) => {
      currentRange = range;
      document
        .querySelectorAll<HTMLButtonElement>("[data-r]")
        .forEach((button) =>
          button.classList.toggle("active", button.dataset.r === range),
        );

      const source =
        range === "1D"
          ? dayPoints
          : minutePoints.length > 1
            ? minutePoints
            : dayPoints;

      const cutoff = Date.now() - RANGE_MS[range];
      let points = source.filter((point) => point.time >= cutoff);

      // Never fake a chart. If the exact interval has too few points, use the
      // closest real source only when it still covers the requested window.
      if (points.length < 2 && range !== "1D") {
        points = dayPoints.filter((point) => point.time >= cutoff);
      }

      if (points.length >= 2) {
        setMarketError(false);
        drawChart(points, range);
      } else {
        setMarketError(true);
      }
    };

    document.querySelectorAll<HTMLButtonElement>("[data-r]").forEach((button) => {
      const rawRange = button.dataset.r;
      if (!RANGE_VALUES.includes(rawRange as ChartRange)) return;
      listen(button, "click", () => renderRange(rawRange as ChartRange));
    });

    const loadMarket = async () => {
      try {
        const now = Date.now();
        const minuteStart = new Date(now - 5 * 60 * 60_000).toISOString();
        const minuteEnd = new Date(now).toISOString();

        const [minuteResponse, fiveMinuteResponse, coingeckoResponse] =
          await Promise.all([
            fetch(
              `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60&start=${encodeURIComponent(minuteStart)}&end=${encodeURIComponent(minuteEnd)}`,
              { headers: { Accept: "application/json" } },
            ),
            fetch(
              "https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=300",
              { headers: { Accept: "application/json" } },
            ),
            fetch(
              "https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=1&precision=full",
              { headers: { Accept: "application/json" } },
            ),
          ]);

        const minutePayload = minuteResponse.ok
          ? ((await minuteResponse.json()) as number[][])
          : [];
        const fiveMinutePayload = fiveMinuteResponse.ok
          ? ((await fiveMinuteResponse.json()) as number[][])
          : [];
        const coingeckoPayload = coingeckoResponse.ok
          ? ((await coingeckoResponse.json()) as { prices?: [number, number][] })
          : {};

        const minute = minutePayload.map((row) => ({
          time: Number(row[0]) * 1000,
          price: Number(row[4]),
        }));

        const daily = fiveMinutePayload.map((row) => ({
          time: Number(row[0]) * 1000,
          price: Number(row[4]),
        }));

        const gecko = (coingeckoPayload.prices || []).map(([time, price]) => ({
          time,
          price,
        }));

        if (destroyed) return;

        minutePoints = normalizeRows(minute);
        dayPoints = normalizeRows([...daily, ...gecko]);

        if (minutePoints.length < 2 && dayPoints.length < 2) {
          throw new Error("No market data");
        }

        renderRange(currentRange);
      } catch {
        if (!destroyed) setMarketError(true);
      }
    };

    void loadMarket();
    const refresh = window.setInterval(() => void loadMarket(), 60_000);
    cleanups.push(() => window.clearInterval(refresh));

    return () => {
      destroyed = true;
      cleanups.reverse().forEach((cleanup) => cleanup());
      document.body.classList.remove("gold-theme-preview");
      delete document.body.dataset.landingTheme;
      delete document.documentElement.dataset.landingTheme;
    };
  }, []);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />
      <div
        className="potapoff-landing"
        dangerouslySetInnerHTML={{ __html: LANDING_BODY }}
      />
    </>
  );
}
