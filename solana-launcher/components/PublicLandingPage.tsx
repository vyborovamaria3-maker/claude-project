"use client";

import {
  Activity,
  ArrowRight,
  Boxes,
  Check,
  Globe2,
  Menu,
  Radar,
  Radio,
  Rocket,
  ShieldCheck,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
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
  points: MarketPoint[];
  source: "CoinGecko";
};

type AuthResponse = {
  access_token?: string;
  expires_in?: number;
  redirect_url?: string;
  detail?: string;
};

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;

function formatUsd(value: number | null | undefined, maximumFractionDigits = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(value);
}

function formatCompactUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function chartPaths(points: MarketPoint[], width = 760, height = 300) {
  if (points.length < 2) return { line: "", area: "" };
  const prices = points.map((point) => point.price);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const rawRange = Math.max(rawMax - rawMin, rawMax * 0.005, 1);
  const min = rawMin - rawRange * 0.12;
  const max = rawMax + rawRange * 0.12;
  const range = max - min;
  const padX = 16;
  const padY = 18;
  const usableWidth = width - padX * 2;
  const usableHeight = height - padY * 2;

  const coords = points.map((point, index) => {
    const x = padX + (index / (points.length - 1)) * usableWidth;
    const y = padY + (1 - (point.price - min) / range) * usableHeight;
    return [x, y] as const;
  });

  const line = coords.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(2)},${height} L${coords[0][0].toFixed(2)},${height} Z`;
  return { line, area };
}

function authError(status: number, detail?: string) {
  if (status === 401) return "Неверный логин или пароль.";
  if (status === 403) return "Срок подписки истёк. Продлите доступ через Telegram.";
  if (status === 422) return "Проверьте формат логина и пароля.";
  if (status === 429) return "Слишком много попыток. Подождите минуту и попробуйте снова.";
  if (status === 503) return "Сервис авторизации временно недоступен.";
  return detail || "Не удалось выполнить вход.";
}

function getAuthEndpoint() {
  const queryApi = new URLSearchParams(window.location.search).get("api");
  const configuredApi = queryApi || document.documentElement.dataset.apiBase || "";
  return configuredApi
    ? `${configuredApi.replace(/\/$/, "")}/api/v1/auth/login-password`
    : "/api/v1/auth/login-password";
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
  { icon: Radio, title: "Live market data", text: "Цена SOL и 24ч график обновляются автоматически." },
  { icon: Globe2, title: "Solana-first", text: "Инструменты собраны вокруг ежедневной работы с Solana." },
  { icon: Zap, title: "Один workspace", text: "Запуск, анализ и мониторинг в одной рабочей среде." },
  { icon: ShieldCheck, title: "Лёгкий интерфейс", text: "Анимации без тяжёлого canvas и лишних chart-бандлов." },
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

  const paths = useMemo(() => chartPaths(market?.points ?? []), [market]);
  const marketPositive = (market?.change24h ?? 0) >= 0;

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
        if (Number.isFinite(data.price) && Array.isArray(data.points)) setMarket(data);
      } catch {
        // The card intentionally degrades to a neutral unavailable state.
      }
    };

    void loadMarket();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMarket();
    }, 60_000);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.setAttribute("data-visible", "true");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -24px" },
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
    document.body.style.overflow = loginOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [loginOpen]);

  const openLogin = () => {
    setMenuOpen(false);
    if (window.location.hash !== "#login") window.history.pushState(null, "", "#login");
    setLoginOpen(true);
  };

  const closeLogin = () => {
    if (window.location.hash === "#login") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
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
      setAuthMessage("Логин: 4–32 символа, латиница, цифры или _. ");
      return;
    }
    if (password.length !== 32) {
      setAuthMessage("Пароль доступа должен содержать 32 символа.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(getAuthEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login: login.trim(), password: password.toUpperCase() }),
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
      window.setTimeout(() => window.location.assign(data.redirect_url || "/dashboard"), 500);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Ошибка входа.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={`${styles.shell} ${styles.headerInner}`}>
          <a className={styles.brand} href="#top" aria-label="POTAPoff — главная">
            <span className={styles.brandMark} aria-hidden="true"><span /><span /><span /></span>
            <span>POTAP<span className={styles.brandGold}>off</span></span>
          </a>

          <nav className={styles.nav} aria-label="Основная навигация">
            <a href="#product">Продукт</a>
            <a href="#features">Возможности</a>
            <a href="#market">Рынок SOL</a>
            <a href="#workspace">Рабочая среда</a>
          </nav>

          <div className={styles.headerActions}>
            <button className={`${styles.button} ${styles.buttonGhost} ${styles.buttonSmall}`} onClick={openLogin}>Войти</button>
            <button className={`${styles.button} ${styles.buttonSmall}`} onClick={openLogin}>Открыть платформу <ArrowRight size={16} /></button>
            <button className={styles.menuButton} onClick={() => setMenuOpen((value) => !value)} aria-label="Открыть меню" aria-expanded={menuOpen}>
              {menuOpen ? <X size={19} /> : <Menu size={19} />}
            </button>
          </div>
        </div>

        <div className={`${styles.shell} ${styles.mobileMenu} ${menuOpen ? styles.mobileMenuOpen : ""}`}>
          <a href="#product" onClick={() => setMenuOpen(false)}>Продукт</a>
          <a href="#features" onClick={() => setMenuOpen(false)}>Возможности</a>
          <a href="#market" onClick={() => setMenuOpen(false)}>Рынок SOL</a>
          <a href="#workspace" onClick={() => setMenuOpen(false)}>Рабочая среда</a>
          <div className={styles.mobileActions}>
            <button className={`${styles.button} ${styles.buttonGhost}`} onClick={openLogin}>Войти</button>
            <button className={styles.button} onClick={openLogin}>Открыть платформу</button>
          </div>
        </div>
      </header>

      <div id="top" className={styles.shell}>
        <section id="product" className={styles.hero}>
          <div data-reveal>
            <div className={styles.eyebrow}><span className={styles.liveDot} /> Профессиональная платформа для Solana</div>
            <h1 className={styles.heroTitle}>POTAPoff — <span className={styles.heroAccent}>интеллектуальное преимущество</span></h1>
            <p className={styles.heroCopy}>
              Запускайте токены, анализируйте кошельки и отслеживайте рынок Solana в одной рабочей среде.
              Меньше шума. Больше контекста. Быстрее решения.
            </p>
            <div className={styles.heroActions}>
              <button className={styles.button} onClick={openLogin}>Открыть платформу <ArrowRight size={17} /></button>
              <a className={`${styles.button} ${styles.buttonGhost}`} href="#features">Смотреть возможности</a>
            </div>
            <div className={styles.heroMeta}>
              <span><i /> Solana-first workflow</span>
              <span><i /> Live market data</span>
              <span><i /> Адаптивно на всех устройствах</span>
            </div>
          </div>

          <div id="market" className={styles.marketStage} data-reveal>
            <div className={styles.marketCard}>
              <div className={styles.marketHead}>
                <div className={styles.marketPair}>
                  <div className={styles.solanaCoin} aria-hidden="true"><span /></div>
                  <div><div className={styles.pairLabel}>SOL / USD</div><div className={styles.pairSub}>Solana · 24 часа</div></div>
                </div>
                <div className={styles.marketStatus}><span className={styles.liveDot} /> LIVE DATA</div>
              </div>

              <div className={styles.marketPriceRow}>
                <div className={styles.marketPrice}>{market ? formatUsd(market.price) : "Загрузка…"}</div>
                {market && <div className={`${styles.marketChange} ${marketPositive ? styles.positive : styles.negative}`}>{formatPercent(market.change24h)}</div>}
              </div>

              <div className={styles.chartWrap}>
                {paths.line ? (
                  <>
                    <svg className={styles.chartSvg} viewBox="0 0 760 300" preserveAspectRatio="none" role="img" aria-label="График цены Solana за последние 24 часа">
                      <defs>
                        <linearGradient id="marketLineGradient" x1="0" x2="1">
                          <stop offset="0%" stopColor="#997444" />
                          <stop offset="52%" stopColor="#e7bd62" />
                          <stop offset="100%" stopColor="#ffe7a4" />
                        </linearGradient>
                        <linearGradient id="marketAreaGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#e7bd62" stopOpacity="0.18" />
                          <stop offset="100%" stopColor="#e7bd62" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <g className={styles.chartGrid}>
                        {[55, 110, 165, 220, 275].map((y) => <line key={y} x1="16" x2="744" y1={y} y2={y} />)}
                        {[150, 300, 450, 600].map((x) => <line key={x} x1={x} x2={x} y1="18" y2="282" />)}
                      </g>
                      <path className={styles.chartArea} d={paths.area} />
                      <path className={styles.chartLine} d={paths.line} />
                    </svg>
                    <div className={styles.chartLabel}>{formatUsd(market?.price)}</div>
                  </>
                ) : <div className={styles.chartFallback}>Получаем реальные данные SOL…</div>}
              </div>

              <div className={styles.marketStats}>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>24ч максимум</div><div className={styles.marketStatValue}>{formatUsd(market?.high24h)}</div></div>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>24ч минимум</div><div className={styles.marketStatValue}>{formatUsd(market?.low24h)}</div></div>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>Объём 24ч</div><div className={styles.marketStatValue}>{formatCompactUsd(market?.volume24h)}</div></div>
                <div className={styles.marketStat}><div className={styles.marketStatLabel}>Market cap</div><div className={styles.marketStatValue}>{formatCompactUsd(market?.marketCap)}</div></div>
              </div>
              <span className={styles.marketSource}>Market data: CoinGecko · обновление ~60 сек</span>
            </div>

            {market && (
              <>
                <div className={`${styles.floatCard} ${styles.floatA}`}>
                  <div className={styles.floatLabel}>Диапазон 24ч</div>
                  <div className={styles.floatValue}>{formatUsd(market.high24h - market.low24h)}</div>
                </div>
                <div className={`${styles.floatCard} ${styles.floatB}`}>
                  <div className={styles.floatLabel}>Изменение</div>
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
            <div className={styles.kicker}>Инструменты, которые работают вместе</div>
            <h2 className={styles.sectionTitle}>Смотрите глубже. Действуйте быстрее.</h2>
            <p className={styles.sectionCopy}>POTAPoff объединяет ключевые этапы работы с Solana в единый продукт — без маркетингового шума и лишних переключений.</p>
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
          <div className={styles.workspace} data-reveal>
            <div className={styles.workspaceCopy}>
              <div className={styles.kicker}>Единый рабочий стол</div>
              <h3>Рынок, кошельки и запуск — в одном контексте</h3>
              <p>Не ещё одна панель ради панели. Интерфейс строится вокруг действий: увидеть сигнал, проверить контекст и перейти к следующему шагу без потери фокуса.</p>
              <div className={styles.workspaceList}>
                <span><i><Check size={12} /></i> Live SOL market context</span>
                <span><i><Check size={12} /></i> Wallet и bundle intelligence</span>
                <span><i><Check size={12} /></i> Быстрый переход к запуску токена</span>
                <span><i><Check size={12} /></i> Один responsive workflow</span>
              </div>
            </div>

            <div className={styles.workspacePreview} aria-hidden="true">
              <div className={styles.previewTop}><span className={styles.previewBrand}>POTAPoff</span><span>SOLANA · LIVE</span></div>
              <div className={styles.previewBody}>
                <div className={styles.previewNav}><span>Обзор рынка</span><span>Кошельки</span><span>Bundle Intelligence</span><span>Запуск токена</span><span>История</span></div>
                <div className={styles.previewMain}>
                  <div className={styles.previewMainTitle}>Solana workspace</div>
                  <div className={styles.previewMetrics}>
                    <div className={styles.previewMetric}><small>SOL / USD</small><strong>{formatUsd(market?.price)}</strong></div>
                    <div className={styles.previewMetric}><small>Объём 24ч</small><strong>{formatCompactUsd(market?.volume24h)}</strong></div>
                    <div className={styles.previewMetric}><small>Изменение</small><strong className={marketPositive ? styles.positive : styles.negative}>{market ? formatPercent(market.change24h) : "—"}</strong></div>
                  </div>
                  <div className={styles.previewChart}>
                    {paths.line ? (
                      <svg viewBox="0 0 760 300" preserveAspectRatio="none"><polyline points={(market?.points ?? []).map((point, index, list) => {
                        const vals = list.map((item) => item.price);
                        const min = Math.min(...vals);
                        const max = Math.max(...vals);
                        const range = Math.max(max - min, 1);
                        return `${(index / Math.max(list.length - 1, 1)) * 760},${275 - ((point.price - min) / range) * 245}`;
                      }).join(" ")} /></svg>
                    ) : <Activity size={28} />}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.cta} data-reveal>
          <div><h2>Ваше преимущество начинается с лучшего контекста.</h2><p>Откройте POTAPoff и соберите весь Solana workflow в одном месте.</p></div>
          <div className={styles.ctaActions}>
            <button className={styles.button} onClick={openLogin}>Открыть платформу <ArrowRight size={17} /></button>
            <a className={`${styles.button} ${styles.buttonGhost}`} href="#market">Посмотреть live SOL</a>
          </div>
        </section>
      </div>

      <footer className={styles.footer}>
        <div className={`${styles.shell} ${styles.footerInner}`}>
          <div>
            <div className={styles.brand}><span className={styles.brandMark} aria-hidden="true"><span /><span /><span /></span><span>POTAP<span className={styles.brandGold}>off</span></span></div>
            <div className={styles.footerCopy}>Профессиональная рабочая среда для запуска, анализа и мониторинга в экосистеме Solana.</div>
          </div>
          <div className={styles.footerLinks}><a href="#features">Возможности</a><a href="#market">Рынок SOL</a><a href="#workspace">Workspace</a></div>
        </div>
      </footer>

      {loginOpen && (
        <div className={styles.loginBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLogin(); }}>
          <div className={styles.loginCard} role="dialog" aria-modal="true" aria-labelledby="login-title">
            <div className={styles.loginTop}>
              <div><h2 id="login-title">Войти в POTAPoff</h2><p>Используйте действующие данные доступа к платформе.</p></div>
              <button className={styles.closeButton} onClick={closeLogin} aria-label="Закрыть"><X size={17} /></button>
            </div>
            <form className={styles.loginForm} onSubmit={submitLogin}>
              <label>Логин<input autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} maxLength={32} /></label>
              <label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={32} /></label>
              <div className={`${styles.loginAlert} ${authSuccess ? styles.loginSuccess : ""}`} aria-live="polite">{authMessage}</div>
              <button className={styles.button} type="submit" disabled={submitting}>{submitting ? "Проверяем доступ…" : "Войти в платформу"}</button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
