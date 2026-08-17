"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./MiniApp.module.css";

type TelegramUser = {
  id?: number;
  first_name?: string;
  username?: string;
};

type MiniAppWebApp = {
  initData?: string;
  initDataUnsafe?: { user?: TelegramUser };
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  openLink?: (url: string) => void;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
  };
};

type SubscriptionConfig = {
  monthlyPriceSol: string;
  monthlyPriceUsdt: string;
  freeDemoEnabled: boolean;
  demoDays: number;
  recipientConfigured: boolean;
  error?: string;
};

type PaidOrder = {
  payload: string;
  login: string;
  status: "paid";
  password: string | null;
  subscriptionExpiresAt?: string | null;
  paymentSignature?: string | null;
};

type VerifyPaymentResponse = {
  status?: "paid" | "pending";
  error?: string;
  payload?: string;
  login?: string;
  password?: string | null;
  subscriptionExpiresAt?: string | null;
  paymentSignature?: string | null;
};

type CheckoutState = {
  payload: string;
  currency: "SOL" | "USDT";
  displayAmount: string;
  paymentUrl: string;
};

type CheckoutResponse = {
  error?: string;
  payload?: string;
  mode?: "PAYMENT" | "DEMO";
  status?: string;
  currency?: "SOL" | "USDT";
  displayAmount?: string;
  paymentUrl?: string;
  login?: string;
  password?: string | null;
  subscriptionExpiresAt?: string | null;
};

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;
const SITE_URL = "https://potapoff.fun";

export default function MiniAppPage() {
  const [login, setLogin] = useState("");
  const [config, setConfig] = useState<SubscriptionConfig | null>(null);
  const [checkout, setCheckout] = useState<CheckoutState | null>(null);
  const [order, setOrder] = useState<PaidOrder | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [copied, setCopied] = useState<"login" | "password" | "payment" | null>(null);
  const [telegramUser, setTelegramUser] = useState<TelegramUser | null>(null);
  const [statusMessage, setStatusMessage] = useState("Подключаем настройки доступа…");

  const webApp =
    typeof window !== "undefined" ? (window.Telegram?.WebApp as MiniAppWebApp | undefined) : undefined;
  const initData = webApp?.initData || "";
  const isTelegram = Boolean(initData);
  const canCheckout = isTelegram || process.env.NODE_ENV !== "production";
  const paid = order?.status === "paid" && Boolean(order.password);

  const loginError = useMemo(() => {
    if (!login) return "";
    return LOGIN_RE.test(login) ? "" : "Логин: 4–32 символа, только A–Z, 0–9 и _.";
  }, [login]);

  const solEnabled = Number(config?.monthlyPriceSol || "0") > 0;
  const usdtEnabled = Number(config?.monthlyPriceUsdt || "0") > 0;
  const displayName = telegramUser?.first_name || telegramUser?.username || "Trader";

  useEffect(() => {
    if (webApp) {
      webApp.ready?.();
      webApp.expand?.();
      webApp.setHeaderColor?.("#05070b");
      webApp.setBackgroundColor?.("#05070b");
      setTelegramUser(webApp.initDataUnsafe?.user || null);
    }

    void (async () => {
      try {
        const response = await fetch("/api/miniapp/config", { cache: "no-store" });
        const data = (await response.json()) as SubscriptionConfig;
        if (!response.ok) throw new Error(data.error || "Не удалось загрузить настройки подписки.");
        setConfig(data);
        setStatusMessage(
          data.freeDemoEnabled
            ? `Демо-доступ активен на ${data.demoDays} дн.`
            : "Введите логин и выберите способ активации доступа.",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Не удалось загрузить настройки подписки.";
        setError(message);
        setStatusMessage("Сервис активации временно недоступен.");
      }
    })();
  }, [webApp]);

  useEffect(() => {
    if (!checkout || paid) return;
    const timer = window.setInterval(() => {
      void verifyPayment(checkout.payload, false);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [checkout, paid]);

  async function createCheckout(method: "SOL" | "USDT" | "DEMO") {
    setError("");
    setLoading(true);
    setOrder(null);
    setCheckout(null);

    try {
      if (!LOGIN_RE.test(login)) throw new Error("Сначала введите корректный логин.");
      if (!canCheckout) throw new Error("Откройте Mini App из Telegram-бота для активации доступа.");

      webApp?.HapticFeedback?.impactOccurred?.("light");
      setStatusMessage(method === "DEMO" ? "Запрашиваем персональный пароль…" : `Создаём платёж ${method}…`);

      const response = await fetch("/api/miniapp/create-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, login, method }),
      });
      const data = (await response.json()) as CheckoutResponse;
      if (!response.ok) throw new Error(data.error || "Не удалось создать запрос доступа.");
      if (!data.payload) throw new Error("Backend вернул неполный запрос доступа.");

      if (data.mode === "DEMO") {
        if (!data.password || !data.login) throw new Error("Backend не выдал данные демо-доступа.");
        setOrder({
          payload: data.payload,
          login: data.login,
          status: "paid",
          password: data.password,
          subscriptionExpiresAt: data.subscriptionExpiresAt,
        });
        setLogin(data.login);
        setStatusMessage("ACCESS TOKEN RECEIVED · данные для входа готовы");
        webApp?.HapticFeedback?.notificationOccurred?.("success");
        return;
      }

      if (!data.currency || !data.displayAmount || !data.paymentUrl) {
        throw new Error("Backend вернул неполный платёжный запрос.");
      }

      setCheckout({
        payload: data.payload,
        currency: data.currency,
        displayAmount: data.displayAmount,
        paymentUrl: data.paymentUrl,
      });
      setStatusMessage(`Ожидаем ${data.displayAmount} ${data.currency}. Подтверждение проверяется автоматически.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ошибка активации.";
      setError(message);
      setStatusMessage("Запрос требует внимания.");
      webApp?.HapticFeedback?.notificationOccurred?.("error");
    } finally {
      setLoading(false);
    }
  }

  async function verifyPayment(payload: string, showPending: boolean) {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);

    try {
      const response = await fetch("/api/miniapp/verify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, payload }),
      });
      const data = (await response.json()) as VerifyPaymentResponse;

      if (response.status === 202 || data.status === "pending") {
        if (showPending) setStatusMessage("Транзакция пока не подтверждена. Продолжаем проверку…");
        return;
      }
      if (!response.ok) throw new Error(data.error || "Не удалось проверить оплату.");
      if (data.status !== "paid" || !data.payload || !data.login || !data.password) {
        throw new Error("Подтверждение оплаты неполное.");
      }

      setOrder({
        payload: data.payload,
        login: data.login,
        status: "paid",
        password: data.password,
        subscriptionExpiresAt: data.subscriptionExpiresAt,
        paymentSignature: data.paymentSignature,
      });
      setLogin(data.login);
      setCheckout(null);
      setStatusMessage("ACCESS TOKEN RECEIVED · 32/32");
      webApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch (err) {
      if (showPending) {
        const message = err instanceof Error ? err.message : "Не удалось проверить оплату.";
        setError(message);
        webApp?.HapticFeedback?.notificationOccurred?.("error");
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  async function copyValue(value: string, key: "login" | "password" | "payment") {
    if (!value) return;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        fallbackCopy(value);
      }
      setCopied(key);
      webApp?.HapticFeedback?.notificationOccurred?.("success");
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 2200);
    } catch {
      fallbackCopy(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 2200);
    }
  }

  function fallbackCopy(value: string) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {
      // Manual long-press remains available in Telegram if the fallback is blocked.
    }
    textarea.remove();
  }

  function openPayment() {
    if (!checkout?.paymentUrl) return;
    webApp?.HapticFeedback?.impactOccurred?.("medium");
    window.location.href = checkout.paymentUrl;
  }

  function openSite() {
    webApp?.HapticFeedback?.impactOccurred?.("light");
    if (webApp?.openLink) {
      webApp.openLink(SITE_URL);
      return;
    }
    window.open(SITE_URL, "_blank", "noopener,noreferrer");
  }

  const statusClass = error
    ? `${styles.status} ${styles.statusError}`
    : paid
      ? `${styles.status} ${styles.statusOk}`
      : styles.status;

  return (
    <main className={styles.shell}>
      <section className={styles.app} aria-label="POTAPoff Telegram Mini App">
        <div className={styles.pad}>
          <header className={styles.top}>
            <div className={styles.logo}>POTAP<span>off</span></div>
            <div className={`${styles.mode} ${!isTelegram ? styles.modePreview : ""}`}>
              {isTelegram ? "SECURE ACCESS" : "PREVIEW MODE"}
            </div>
          </header>

          <section className={styles.hero}>
            <div className={styles.eyebrow}>TELEGRAM MINI APP / ACCESS</div>
            <h1>Hologram Pro<br /><span>Plasma Sweep edition</span></h1>
            <p>
              {isTelegram ? `Привет, ${displayName}. ` : ""}
              Введите логин. После подтверждения backend здесь появится персональный 32-символьный пароль.
            </p>
          </section>

          <section className={styles.card}>
            <div className={styles.label}><span>LOGIN</span><small>4–32 символа</small></div>
            <div className={styles.fieldRow}>
              <div className={styles.fieldShell}>
                <input
                  className={styles.field}
                  value={login}
                  onChange={(event) => setLogin(event.target.value)}
                  placeholder="Логин"
                  autoComplete="username"
                  maxLength={32}
                  disabled={loading || paid}
                />
              </div>
              {paid && order ? (
                <button
                  className={`${styles.copyBtn} ${copied === "login" ? styles.plasmaDone : ""}`}
                  type="button"
                  onClick={() => copyValue(order.login, "login")}
                >
                  <span className={styles.copyLabel}>{copied === "login" ? "✓ COPIED" : "COPY"}</span>
                </button>
              ) : null}
            </div>

            <div className={styles.label}><span>PASSWORD</span><small>32 символа</small></div>
            <div className={styles.fieldRow}>
              <div className={`${styles.passwordShell} ${paid ? styles.passwordReady : ""}`}>
                <input
                  className={`${styles.field} ${paid ? styles.readyField : ""}`}
                  value={paid && order?.password ? order.password : ""}
                  placeholder={loading || checking ? "Получаем доступ…" : "Пароль"}
                  readOnly
                  aria-label="Password"
                />
              </div>
              {paid && order?.password ? (
                <button
                  className={`${styles.copyBtn} ${copied === "password" ? styles.plasmaDone : ""}`}
                  type="button"
                  onClick={() => copyValue(order.password || "", "password")}
                >
                  <span className={styles.copyLabel}>{copied === "password" ? "✓ COPIED" : "COPY"}</span>
                </button>
              ) : null}
            </div>

            <div className={styles.meta}>
              <span>A–Z · 0–9</span>
              <span className={styles.secure}>encrypted delivery</span>
            </div>

            {loginError ? <div className={styles.warning}>{loginError}</div> : null}
            {!isTelegram && process.env.NODE_ENV === "production" ? (
              <div className={styles.warning}>Активация доступна только внутри Telegram Mini App.</div>
            ) : null}
            {error ? <div className={styles.error}>{error}</div> : null}

            {!paid && !checkout ? (
              config?.freeDemoEnabled ? (
                <button
                  className={styles.primaryBtn}
                  type="button"
                  onClick={() => createCheckout("DEMO")}
                  disabled={loading || !login || Boolean(loginError) || !canCheckout}
                >
                  {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
                  {loading ? "Получаем пароль…" : "Получить пароль"}
                </button>
              ) : (
                <div className={styles.paymentGrid}>
                  <button
                    className={styles.paymentBtn}
                    type="button"
                    onClick={() => createCheckout("SOL")}
                    disabled={loading || !solEnabled || !config?.recipientConfigured || !login || Boolean(loginError) || !canCheckout}
                  >
                    {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
                    {solEnabled ? `Оплатить ${config?.monthlyPriceSol} SOL` : "SOL недоступен"}
                  </button>
                  <button
                    className={styles.paymentBtn}
                    type="button"
                    onClick={() => createCheckout("USDT")}
                    disabled={loading || !usdtEnabled || !config?.recipientConfigured || !login || Boolean(loginError) || !canCheckout}
                  >
                    {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
                    {usdtEnabled ? `Оплатить ${config?.monthlyPriceUsdt} USDT` : "USDT недоступен"}
                  </button>
                </div>
              )
            ) : null}

            {checkout ? (
              <div className={styles.paymentPanel}>
                <div className={styles.paymentTop}>
                  <div>
                    <div className={styles.paymentKicker}>SOLANA PAYMENT</div>
                    <div className={styles.paymentAmount}>{checkout.displayAmount} {checkout.currency}</div>
                    <div className={styles.paymentText}>Откройте Solana Pay. После транзакции пароль появится автоматически.</div>
                  </div>
                  <div className={styles.paymentBadge}>PENDING</div>
                </div>
                <button className={styles.primaryBtn} type="button" onClick={openPayment}>Открыть в кошельке</button>
                <button
                  className={styles.secondaryBtn}
                  type="button"
                  onClick={() => copyValue(checkout.paymentUrl, "payment")}
                >
                  {copied === "payment" ? "✓ Ссылка скопирована" : "Скопировать Solana Pay ссылку"}
                </button>
                <button
                  className={`${styles.secondaryBtn} ${styles.secondaryBtnGreen}`}
                  type="button"
                  disabled={checking}
                  onClick={() => verifyPayment(checkout.payload, true)}
                >
                  {checking ? <span className={`${styles.spinner} ${styles.spinnerLight}`} aria-hidden="true" /> : null}
                  {checking ? "Проверяем…" : "Я оплатил — проверить"}
                </button>
              </div>
            ) : null}

            {paid && order ? (
              <div className={styles.siteCtaWrap}>
                <button className={styles.siteCta} type="button" onClick={openSite}>
                  Перейти на сайт POTAPoff
                  <span className={styles.siteCtaArrow}>↗</span>
                </button>
                <div className={styles.siteHint}>Используйте созданные логин и пароль для входа</div>
                {order.subscriptionExpiresAt ? (
                  <div className={styles.siteHint}>Доступ до {new Date(order.subscriptionExpiresAt).toLocaleDateString("ru-RU")}</div>
                ) : null}
              </div>
            ) : null}

            <div className={statusClass}>{statusMessage}</div>
            <div className={styles.note}>Пароль выдаётся backend только после подтверждения доступа.</div>

            <div className={styles.trust} aria-label="Security features">
              <div className={styles.trustItem}><span className={styles.trustDot} />TELEGRAM INIT DATA</div>
              <div className={styles.trustItem}><span className={styles.trustDot} />ON-CHAIN VERIFY</div>
              <div className={styles.trustItem}><span className={styles.trustDot} />PRIVATE CREDENTIALS</div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
