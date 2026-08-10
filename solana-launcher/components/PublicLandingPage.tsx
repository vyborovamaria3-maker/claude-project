"use client";

import {
  Activity,
  ArrowRight,
  Boxes,
  Check,
  Globe2,
  Menu,
  Palette,
  Radar,
  Radio,
  Rocket,
  ShieldCheck,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./landing/PremiumLanding.module.css";

type MarketPoint = { time: number; price: number };
type MarketData = {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number | null;
  marketCap: number | null;
  updatedAt: number;
  servedAt: number;
  windowStart: number;
  windowEnd: number;
  sourcePointCount: number;
  plottedPointCount: number;
  stale: boolean;
  staleReason: "delayed_source" | "upstream_error" | null;
  points: MarketPoint[];
  source: "CoinGecko";
  quote: "USD";
};

type AuthResponse = {
  access_token?: string;
  expires_in?: number;
  detail?: string;
};

type LandingTheme = "gold" | "solana";
type ChartCoord = MarketPoint & { x: number; y: number };

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;
const THEME_KEY = "potapoff.landing_theme";
const AUTH_ENDPOINT = "/api/v1/auth/login-password";
const CHART_WIDTH = 760;
const CHART_HEIGHT = 300;
const AUTH_TIMEOUT_MS = 12_000;
const USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const COMPACT_USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});
const MARKET_TIME_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
});

function formatUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return USD_FORMAT.format(value);
}

function formatCompactUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return COMPACT_USD_FORMAT.format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatMarketTime(timestamp: number | null | undefined) {
  if (!timestamp || !Number.isFinite(timestamp)) return "";
  return MARKET_TIME_FORMAT.format(new Date(timestamp));
}

function formatMarketAge(updatedAt: number | null | undefined, servedAt: number | null | undefined) {
  if (!updatedAt || !servedAt || !Number.isFinite(updatedAt) || !Number.isFinite(servedAt)) return "";
  const seconds = Math.max(0, Math.floor((servedAt - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}с назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м назад`;
  const hours = Math.floor(minutes / 60);
  return `${hours}ч ${minutes % 60}м назад`;
}

function chartPaths(points: MarketPoint[], width = CHART_WIDTH, height = CHART_HEIGHT) {
  if (points.length < 2) {
    return {
      line: "",
      area: "",
      mini: "",
      labelTop: 50,
      coords: [] as ChartCoord[],
      highCoord: null as ChartCoord | null,
      lowCoord: null as ChartCoord | null,
    };
  }

  const prices = points.map((point) => point.price);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const rawRange = Math.max(rawMax - rawMin, rawMax * 0.005, 1);
  const min = rawMin - rawRange * 0.12;
  const max = rawMax + rawRange * 0.12;
  const range = max - min;
  const startTime = points[0].time;
  const endTime = points[points.length - 1].time;
  const timeRange = Math.max(1, endTime - startTime);
  const padX = 16;
  const padY = 18;
  const usableWidth = width - padX * 2;
  const usableHeight = height - padY * 2;

  const coords: ChartCoord[] = points.map((point) => ({
    ...point,
    x: padX + ((point.time - startTime) / timeRange) * usableWidth,
    y: padY + (1 - (point.price - min) / range) * usableHeight,
  }));

  const line = coords
    .map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
  const area = `${line} L${coords[coords.length - 1].x.toFixed(2)},${height} L${coords[0].x.toFixed(2)},${height} Z`;
  const mini = coords.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const lastY = coords[coords.length - 1].y;
  const labelTop = Math.min(92, Math.max(8, (lastY / height) * 100));
  const highCoord = coords.reduce((best, point) => (point.price > best.price ? point : best));
  const lowCoord = coords.reduce((best, point) => (point.price < best.price ? point : best));

  return { line, area, mini, labelTop, coords, highCoord, lowCoord };
}

function isValidMarketData(data: MarketData) {
  if (
    data.source !== "CoinGecko" ||
    data.quote !== "USD" ||
    !Number.isFinite(data.price) ||
    data.price <= 0 ||
    !Array.isArray(data.points) ||
    data.points.length < 24
  ) {
    return false;
  }

  return data.points.every((point, index) => {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.price) || point.time <= 0 || point.price <= 0) {
      return false;
    }
    return index === 0 || point.time > data.points[index - 1].time;
  });
}

function authError(status: number, detail?: string) {
  if (status === 401) return "Неверный логин или пароль.";
  if (status === 403) return "Срок подписки истёк. Продлите доступ через Telegram.";
  if (status === 422) return "Проверьте формат логина и пароля.";
  if (status === 429) return "Слишком много попыток. Подождите минуту и попробуйте снова.";
  if (status === 503) return "Сервис авторизации временно недоступен.";
  return detail || "Не удалось выполнить вход.";
}

const features = [
  {
    icon: Rocket,
    title: "Запуск токенов",
    text: "Создавайте и запускайте токены на Solana в одном потоке — от параметров до финальной проверки.",
    link: "Перейти к запуску",
  },
  {
    icon: WalletCards,
    title: "Wallet Intelligence",
    text: "Разбирайте поведение кошельков, историю сделок и движение капитала без постоянного переключения между сервисами.",
    link: "Исследовать кошельки",
  },
  {
    icon: Radar,
    title: "Сканер рынка",
    text: "Следите за динамикой рынка, новыми активами и ключевыми сигналами, когда скорость решения действительно важна.",
    link: "Открыть обзор рынка",
  },
  {
    icon: Boxes,
    title: "Bundle Intelligence",
    text: "Анализируйте бандлы, связанные операции и структуру активности, чтобы быстрее понимать контекст движения токена.",
    link: "Анализировать бандлы",
  },
];

const proof = [
  { icon: ShieldCheck, title: "Контекст перед действием", text: "Проверка рынка и активности до следующего шага." },
  { icon: Radio, title: "Live SOL market", text: "Цена и 24ч график приходят из реального market feed." },
  { icon: Zap, title: "Быстрый workflow", text: "Запуск, анализ и мониторинг без лишних переходов." },
  { icon: Globe2, title: "Solana-first", text: "Интерфейс и инструменты сфокусированы на экосистеме Solana." },
];

export default function PublicLandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authSuccess, setAuthSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [market, setMarket] = useState<MarketData | null>(null);
  const [theme, setTheme] = useState<LandingTheme>("gold");
  const [activeChartIndex, setActiveChartIndex] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const loginInputRef = useRef<HTMLInputElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const authAbortRef = useRef<AbortController | null>(null);
  const redirectTimerRef = useRef<number | null>(null);

  const paths = useMemo(() => chartPaths(market?.points ?? []), [market]);
  const marketPositive = (market?.change24h ?? 0) >= 0;
  const marketFresh = Boolean(market && !market.stale);
  const activeCoord = activeChartIndex == null ? null : paths.coords[activeChartIndex] ?? null;

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "gold" || saved === "solana") setTheme(saved);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const loadMarket = async () => {
      try {
        const response = await fetch("/api/market/solana", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as MarketData;
        if (isValidMarketData(data)) {
          setMarket(data);
          setActiveChartIndex(null);
        }
      } catch {
        // The landing stays usable if the external market source is temporarily unavailable.
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadMarket();
    };

    void loadMarket();
    const timer = window.setInterval(refreshWhenVisible, 60_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!("IntersectionObserver" in window)) {
      document.querySelectorAll("[data-reveal]").forEach((node) => node.setAttribute("data-visible", "true"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.setAttribute("data-visible", "true");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -24px" },
    );

    document.querySelectorAll("[data-reveal]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const syncHash = () => setLoginOpen(window.location.hash === "#login");
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 980) setMenuOpen(false);
    };
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!loginOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => loginInputRef.current?.focus());

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);

      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      document.body.style.overflow = previousOverflow;
      authAbortRef.current?.abort();
      authAbortRef.current = null;
      if (redirectTimerRef.current != null) {
        window.clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }

      const previous = lastFocusedRef.current;
      const target = previous && previous.isConnected && previous.getClientRects().length > 0
        ? previous
        : menuButtonRef.current;
      if (target) window.requestAnimationFrame(() => target.focus());
    };
  }, [loginOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (loginOpen) {
        if (window.location.hash === "#login") {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        }
        setLoginOpen(false);
        setAuthMessage("");
        setAuthSuccess(false);
      } else if (menuOpen) {
        setMenuOpen(false);
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [loginOpen, menuOpen]);

  useEffect(() => () => {
    authAbortRef.current?.abort();
    if (redirectTimerRef.current != null) window.clearTimeout(redirectTimerRef.current);
  }, []);

  const toggleTheme = () => {
    setTheme((value) => {
      const next = value === "gold" ? "solana" : "gold";
      window.localStorage.setItem(THEME_KEY, next);
      return next;
    });
  };

  const inspectChart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paths.coords.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;

    const localX = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    const targetX = (localX / rect.width) * CHART_WIDTH;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    paths.coords.forEach((point, index) => {
      const distance = Math.abs(point.x - targetX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    setActiveChartIndex(nearestIndex);
  };

  const inspectChartKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!paths.coords.length || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    setActiveChartIndex((current) => {
      const fallback = paths.coords.length - 1;
      const base = current == null ? fallback : current;
      return event.key === "ArrowLeft"
        ? Math.max(0, base - 1)
        : Math.min(paths.coords.length - 1, base + 1);
    });
  };

  const openLogin = () => {
    setMenuOpen(false);
    if (document.activeElement instanceof HTMLElement) lastFocusedRef.current = document.activeElement;
    if (window.location.hash !== "#login") window.history.pushState(null, "", "#login");
    setLoginOpen(true);
  };

  const closeLogin = () => {
    if (window.location.hash === "#login") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    authAbortRef.current?.abort();
    if (redirectTimerRef.current != null) {
      window.clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
    setLoginOpen(false);
    setAuthMessage("");
    setAuthSuccess(false);
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthMessage("");
    setAuthSuccess(false);

    if (!LOGIN_RE.test(login.trim())) {
      setAuthMessage("Логин: 4–32 символа, латиница, цифры или _.");
      loginInputRef.current?.focus();
      return;
    }
    if (password.length !== 32) {
      setAuthMessage("Пароль доступа должен содержать 32 символа.");
      return;
    }

    authAbortRef.current?.abort();
    const controller = new AbortController();
    authAbortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AUTH_TIMEOUT_MS);

    setSubmitting(true);
    try {
      const response = await fetch(AUTH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: login.trim(), password: password.toUpperCase() }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data: AuthResponse = {};
      try {
        data = raw ? (JSON.parse(raw) as AuthResponse) : {};
      } catch {
        data = { detail: raw };
      }

      if (!response.ok) throw new Error(authError(response.status, data.detail));
      if (!data.access_token) throw new Error("Сервер не вернул токен доступа.");

      window.localStorage.setItem("potapoff.access_token", data.access_token);
      window.localStorage.setItem(
        "potapoff.auth_meta",
        JSON.stringify({
          access_token: data.access_token,
          expires_in: data.expires_in || 86400,
          saved_at: Date.now(),
        }),
      );
      setAuthSuccess(true);
      setAuthMessage("Доступ подтверждён. Открываем платформу…");
      redirectTimerRef.current = window.setTimeout(() => window.location.assign("/dashboard"), 500);
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      if (timedOut) {
        setAuthMessage("Сервис авторизации не ответил вовремя. Попробуйте ещё раз.");
      } else {
        setAuthMessage(error instanceof Error ? error.message : "Ошибка входа.");
      }
    } finally {
      window.clearTimeout(timeout);
      if (authAbortRef.current === controller) authAbortRef.current = null;
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.page} data-theme={theme}>
      <header className={styles.header}>
        <div className={`${styles.shell} ${styles.headerInner}`} data-landing-header-inner>
          <a className={styles.brand} href="#top" aria-label="POTAPoff — главная">
            <span className={styles.brandMark} aria-hidden="true"><span /><span /><span /></span>
            <span>POTAP<span className={styles.brandAccent}>off</span></span>
          </a>

          <nav className={styles.nav} aria-label="Основная навигация">
            <a href="#product">Продукт</a>
            <a href="#features">Возможности</a>
            <a href="#market">Рынок SOL</a>
            <a href="#workspace">Рабочая среда</a>
          </nav>

          <div className={styles.headerActions}>
            <button
              data-landing-theme-toggle
              className={styles.themeToggle}
              type="button"
              onClick={toggleTheme}
              aria-pressed={theme === "solana"}
              aria-label={`Переключить тему. Сейчас ${theme === "gold" ? "Gold" : "Solana"}`}
              title={`Тема: ${theme === "gold" ? "Gold" : "Solana"}`}
            >
              <Palette size={15} />
              <span className={styles.themeSwatches} aria-hidden="true"><i /><i /></span>
              <span className={styles.themeLabel}>{theme === "gold" ? "Gold" : "Solana"}</span>
            </button>
            <button type="button" className={`${styles.button} ${styles.buttonGhost} ${styles.buttonSmall}`} onClick={openLogin}>Войти</button>
            <button type="button" className={`${styles.button} ${styles.buttonSmall} ${styles.desktopCta}`} onClick={openLogin}>Открыть платформу <ArrowRight size={16} /></button>
            <button
              data-landing-menu-toggle
              ref={menuButtonRef}
              type="button"
              className={styles.menuButton}
              onClick={() => setMenuOpen((value) => !value)}
              aria-label={menuOpen ? "Закрыть меню" : "Открыть меню"}
              aria-expanded={menuOpen}
              aria-controls="landing-mobile-menu"
            >
              {menuOpen ? <X size={19} /> : <Menu size={19} />}
            </button>
          </div>
        </div>

        <div id="landing-mobile-menu" className={`${styles.shell} ${styles.mobileMenu} ${menuOpen ? styles.mobileMenuOpen : ""}`} aria-hidden={!menuOpen}>
          <a href="#product" onClick={() => setMenuOpen(false)}>Продукт</a>
          <a href="#features" onClick={() => setMenuOpen(false)}>Возможности</a>
          <a href="#market" onClick={() => setMenuOpen(false)}>Рынок SOL</a>
          <a href="#workspace" onClick={() => setMenuOpen(false)}>Рабочая среда</a>
          <div className={styles.mobileActions} data-landing-mobile-actions>
            <button type="button" className={`${styles.button} ${styles.buttonGhost}`} onClick={openLogin}>Войти</button>
            <button type="button" className={styles.button} onClick={openLogin}>Открыть платформу</button>
          </div>
        </div>
      </header>

      <div id="top" className={styles.shell}>
        <section id="product" className={styles.hero}>
          <div className={styles.heroCopyBlock} data-landing-hero-copy data-reveal>
            <div className={styles.eyebrow}><span className={styles.liveDot} /> Профессиональная платформа для Solana</div>
            <h1 className={styles.heroTitle}>POTAPoff — <span className={styles.heroAccent}>интеллектуальное преимущество</span></h1>
            <p className={styles.heroCopy}>
              Запускайте токены, анализируйте кошельки и отслеживайте рынок Solana в одной рабочей среде.
              Данные. Скорость. Контроль.
            </p>
            <div className={styles.heroActions}>
              <button type="button" className={styles.button} onClick={openLogin}>Открыть платформу <ArrowRight size={17} /></button>
              <a className={`${styles.button} ${styles.buttonGhost}`} href="#features">Смотреть возможности</a>
            </div>
            <div className={styles.heroMeta}>
              <span><i /> Реальный SOL/USD</span>
              <span><i /> Реальные market points</span>
              <span><i /> Телефон · планшет · desktop</span>
            </div>
          </div>

          <div id="market" className={styles.marketStage} data-reveal>
            <div className={styles.marketGlow} aria-hidden="true" />
            <div className={styles.marketCard} data-landing-market-card>
              <div className={styles.marketHead} data-landing-market-head>
                <div className={styles.marketPair}>
                  <div className={styles.solanaCoin} aria-hidden="true"><span /></div>
                  <div>
                    <div className={styles.pairLabel}>SOL / USD</div>
                    <div className={styles.pairSub}>Solana · реальный рынок · 24 часа</div>
                  </div>
                </div>
                <div data-landing-market-status className={`${styles.marketStatus} ${market && !marketFresh ? styles.marketStatusStale : ""}`}>
                  <span className={styles.liveDot} />
                  {market ? (marketFresh ? "LIVE" : "ЗАДЕРЖКА") : "СИНХРОНИЗАЦИЯ"}
                </div>
              </div>

              <div className={styles.marketPriceRow}>
                <div className={styles.marketPrice}>{market ? formatUsd(market.price) : "Загрузка…"}</div>
                {market && <div className={`${styles.marketChange} ${marketPositive ? styles.positive : styles.negative}`}>{formatPercent(market.change24h)}</div>}
              </div>

              <div
                data-landing-chart
                className={`${styles.chartWrap} ${paths.line ? styles.chartInteractive : ""}`}
                onPointerMove={inspectChart}
                onPointerDown={inspectChart}
                onPointerLeave={(event) => {
                  if (event.pointerType !== "touch") setActiveChartIndex(null);
                }}
                onPointerCancel={() => setActiveChartIndex(null)}
                onKeyDown={inspectChartKeyboard}
                role="group"
                tabIndex={paths.line ? 0 : -1}
                aria-label="Интерактивный график реальных точек цены Solana за 24 часа. Используйте стрелки влево и вправо для просмотра точек."
              >
                {paths.line ? (
                  <>
                    <svg className={styles.chartSvg} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="Реальный график цены Solana за последние 24 часа">
                      <defs>
                        <linearGradient id="potap-market-line" x1="0" x2="1">
                          <stop offset="0%" stopColor="var(--chart-a)" />
                          <stop offset="52%" stopColor="var(--chart-b)" />
                          <stop offset="100%" stopColor="var(--chart-c)" />
                        </linearGradient>
                        <linearGradient id="potap-market-area" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-b)" stopOpacity="0.19" />
                          <stop offset="100%" stopColor="var(--chart-b)" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <g className={styles.chartGrid} data-landing-chart-grid>
                        {[55, 110, 165, 220, 275].map((y) => <line key={y} x1="16" x2="744" y1={y} y2={y} />)}
                        {[150, 300, 450, 600].map((x) => <line key={x} x1={x} x2={x} y1="18" y2="282" />)}
                      </g>
                      <path className={styles.chartArea} d={paths.area} />
                      <path className={styles.chartLine} data-landing-chart-line d={paths.line} />

                      {paths.highCoord && (
                        <circle className={styles.chartExtreme} cx={paths.highCoord.x} cy={paths.highCoord.y} r="3.2" />
                      )}
                      {paths.lowCoord && (
                        <circle className={styles.chartExtreme} cx={paths.lowCoord.x} cy={paths.lowCoord.y} r="3.2" />
                      )}

                      {activeCoord && (
                        <g className={styles.chartCursor} aria-hidden="true">
                          <line x1={activeCoord.x} x2={activeCoord.x} y1="18" y2="282" />
                          <circle cx={activeCoord.x} cy={activeCoord.y} r="5" />
                          <circle className={styles.chartCursorCore} cx={activeCoord.x} cy={activeCoord.y} r="2" />
                        </g>
                      )}
                    </svg>

                    {activeCoord ? (
                      <div
                        data-landing-chart-tooltip
                        className={styles.chartTooltip}
                        aria-live="polite"
                        style={{
                          left: `${Math.min(90, Math.max(10, (activeCoord.x / CHART_WIDTH) * 100))}%`,
                        }}
                      >
                        <strong>{formatUsd(activeCoord.price)}</strong>
                        <span>{formatMarketTime(activeCoord.time)}</span>
                      </div>
                    ) : (
                      <div className={styles.chartLabel} style={{ top: `${paths.labelTop}%` }}>{formatUsd(market?.price)}</div>
                    )}
                  </>
                ) : <div className={styles.chartFallback}>Получаем рыночные данные SOL…</div>}
              </div>

              <div className={styles.chartTimeline} aria-hidden="true"><span>−24ч</span><span>−18ч</span><span>−12ч</span><span>−6ч</span><span>сейчас</span></div>
              <div className={styles.chartVerification}>
                <span>Проведите по графику — каждая показанная цена привязана к реальной временной точке.</span>
                <strong>{market ? `${market.plottedPointCount} точек на графике` : ""}</strong>
              </div>

              <div className={styles.marketStats}>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>24ч максимум</div><div className={styles.marketStatValue}>{formatUsd(market?.high24h)}</div></div>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>24ч минимум</div><div className={styles.marketStatValue}>{formatUsd(market?.low24h)}</div></div>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>Объём 24ч</div><div className={styles.marketStatValue}>{formatCompactUsd(market?.volume24h)}</div></div>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>Market cap</div><div className={styles.marketStatValue}>{formatCompactUsd(market?.marketCap)}</div></div>
              </div>
              <span className={styles.marketSource}>
                {market
                  ? `CoinGecko · ${market.sourcePointCount} исходных точек · ${formatMarketAge(market.updatedAt, market.servedAt)} · ${formatMarketTime(market.updatedAt)}`
                  : "CoinGecko · ожидаем данные"}
              </span>
            </div>

            {market && (
              <>
                <div className={`${styles.floatCard} ${styles.floatA}`}>
                  <div className={styles.floatLabel}>Диапазон 24ч</div>
                  <div className={styles.floatValue}>{formatUsd(market.high24h - market.low24h)}</div>
                </div>
                <div className={`${styles.floatCard} ${styles.floatB}`}>
                  <div className={styles.floatLabel}>Изменение 24ч</div>
                  <div className={`${styles.floatValue} ${marketPositive ? styles.positive : styles.negative}`}>{formatPercent(market.change24h)}</div>
                </div>
              </>
            )}
          </div>
        </section>

        <section className={styles.proofStrip} data-reveal aria-label="Ключевые преимущества">
          {proof.map(({ icon: Icon, title, text }) => (
            <div className={styles.proofItem} key={title}>
              <div className={styles.proofIcon}><Icon size={18} /></div>
              <div><div className={styles.proofTitle}>{title}</div><div className={styles.proofText}>{text}</div></div>
            </div>
          ))}
        </section>

        <section id="features" className={styles.section}>
          <div className={styles.sectionHead} data-reveal>
            <div className={styles.kicker}>Всё, что нужно для преимущества на рынке</div>
            <h2 className={styles.sectionTitle}>Один продукт вместо набора разрозненных инструментов.</h2>
            <p className={styles.sectionCopy}>От первого сигнала до запуска и проверки контекста — POTAPoff объединяет ежедневный Solana workflow в одном интерфейсе.</p>
          </div>
          <div className={styles.featureGrid}>
            {features.map(({ icon: Icon, title, text, link }) => (
              <article className={styles.featureCard} key={title} data-reveal>
                <div className={styles.featureIcon}><Icon size={22} /></div>
                <h3 className={styles.featureTitle}>{title}</h3>
                <p className={styles.featureText}>{text}</p>
                <a className={styles.featureLink} href="#workspace">{link} →</a>
              </article>
            ))}
          </div>
        </section>

        <section id="workspace" className={styles.section}>
          <div className={styles.workspace} data-landing-workspace-card data-reveal>
            <div className={styles.workspaceCopy}>
              <div className={styles.kicker}>Профессиональная рабочая среда</div>
              <h3>Рынок, кошельки и запуск — в одном контексте</h3>
              <p>Интерфейс строится вокруг действий: увидеть сигнал, проверить контекст и перейти к следующему шагу без потери фокуса.</p>
              <div className={styles.workspaceList}>
                <span><i><Check size={12} /></i> Live SOL market context</span>
                <span><i><Check size={12} /></i> Wallet и bundle intelligence</span>
                <span><i><Check size={12} /></i> Быстрый переход к запуску токена</span>
                <span><i><Check size={12} /></i> Один responsive workflow</span>
              </div>
              <button type="button" className={styles.button} onClick={openLogin}>Открыть workspace <ArrowRight size={16} /></button>
            </div>

            <div className={styles.workspacePreview} aria-hidden="true">
              <div className={styles.previewTop}><span className={styles.previewBrand}>POTAPoff</span><span>SOLANA · {marketFresh ? "LIVE" : "MARKET"}</span></div>
              <div className={styles.previewBody} data-landing-preview-body>
                <div className={styles.previewNav} data-landing-preview-nav><span>Обзор рынка</span><span>Кошельки</span><span>Bundle Intelligence</span><span>Запуск токена</span><span>История</span></div>
                <div className={styles.previewMain}>
                  <div className={styles.previewMainTitle}>Solana workspace</div>
                  <div className={styles.previewMetrics}>
                    <div className={styles.previewMetric}><small>SOL / USD</small><strong>{formatUsd(market?.price)}</strong></div>
                    <div className={styles.previewMetric}><small>Объём 24ч</small><strong>{formatCompactUsd(market?.volume24h)}</strong></div>
                    <div className={styles.previewMetric}><small>Изменение</small><strong className={marketPositive ? styles.positive : styles.negative}>{market ? formatPercent(market.change24h) : "—"}</strong></div>
                  </div>
                  <div className={styles.previewChart}>
                    {paths.mini ? <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none"><polyline points={paths.mini} /></svg> : <Activity size={28} />}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.cta} data-landing-cta data-reveal>
          <div><div className={styles.ctaCrown} aria-hidden="true">✦</div><h2>Будущее Solana начинается с лучшего контекста.</h2><p>Откройте POTAPoff и соберите весь рабочий процесс в одном месте.</p></div>
          <div className={styles.ctaActions}>
            <button type="button" className={styles.button} onClick={openLogin}>Открыть POTAPoff <ArrowRight size={17} /></button>
            <button className={`${styles.button} ${styles.buttonGhost}`} type="button" onClick={toggleTheme}>Тема: {theme === "gold" ? "Gold" : "Solana"}</button>
          </div>
        </section>
      </div>

      <footer className={styles.footer}>
        <div className={`${styles.shell} ${styles.footerInner}`} data-landing-footer-inner>
          <div>
            <div className={styles.brand}><span className={styles.brandMark} aria-hidden="true"><span /><span /><span /></span><span>POTAP<span className={styles.brandAccent}>off</span></span></div>
            <div className={styles.footerCopy}>Профессиональная рабочая среда для запуска, анализа и мониторинга в экосистеме Solana.</div>
          </div>
          <div className={styles.footerLinks}><a href="#features">Возможности</a><a href="#market">Рынок SOL</a><a href="#workspace">Workspace</a></div>
        </div>
      </footer>

      {loginOpen && (
        <div className={styles.loginBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLogin(); }}>
          <div ref={dialogRef} className={styles.loginCard} role="dialog" aria-modal="true" aria-labelledby="login-title">
            <div className={styles.loginTop}>
              <div><h2 id="login-title">Войти в POTAPoff</h2><p>Используйте действующие данные доступа к платформе.</p></div>
              <button type="button" className={styles.closeButton} onClick={closeLogin} aria-label="Закрыть"><X size={17} /></button>
            </div>
            <form className={styles.loginForm} onSubmit={submitLogin}>
              <label>Логин<input ref={loginInputRef} name="username" autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} maxLength={32} /></label>
              <label>Пароль<input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={32} /></label>
              <div className={`${styles.loginAlert} ${authSuccess ? styles.loginSuccess : ""}`} aria-live="polite">{authMessage}</div>
              <button className={styles.button} type="submit" disabled={submitting}>{submitting ? "Проверяем доступ…" : "Войти в платформу"}</button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
