"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  Copy,
  CreditCard,
  KeyRound,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";

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
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
  };
};

type SubscriptionConfig = {
  monthlyPriceSol: string;
  monthlyPriceUsdt: string;
  paidSubscriptionsEnabled: boolean;
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
  status?: "paid" | "pending" | "none";
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
  const [statusMessage, setStatusMessage] = useState("Loading subscription settings…");

  const webApp =
    typeof window !== "undefined" ? (window.Telegram?.WebApp as MiniAppWebApp | undefined) : undefined;
  const initData = webApp?.initData || "";
  const isTelegram = Boolean(initData);
  const canCheckout = isTelegram || process.env.NODE_ENV !== "production";
  const paid = order?.status === "paid" && Boolean(order.password);

  const loginError = useMemo(() => {
    if (!login) return "";
    return LOGIN_RE.test(login) ? "" : "Use 4-32 characters: letters, digits, or underscore.";
  }, [login]);

  const displayName = telegramUser?.first_name || telegramUser?.username || "Trader";
  const paidModeEnabled = Boolean(config?.paidSubscriptionsEnabled);
  const solEnabled = paidModeEnabled && Number(config?.monthlyPriceSol || "0") > 0;
  const usdtEnabled = paidModeEnabled && Number(config?.monthlyPriceUsdt || "0") > 0;

  useEffect(() => {
    if (webApp) {
      webApp.ready?.();
      webApp.expand?.();
      webApp.setHeaderColor?.("#06100c");
      webApp.setBackgroundColor?.("#06100c");
      setTelegramUser(webApp.initDataUnsafe?.user || null);
    }

    void (async () => {
      try {
        const response = await fetch("/api/miniapp/config", { cache: "no-store" });
        const data = (await response.json()) as SubscriptionConfig;
        if (!response.ok) throw new Error(data.error || "Unable to load subscription settings.");
        setConfig(data);

        if (data.freeDemoEnabled && data.paidSubscriptionsEnabled) {
          setStatusMessage(
            `Free ${data.demoDays}-day demo is available, or choose a paid 30-day subscription.`
          );
        } else if (data.freeDemoEnabled) {
          setStatusMessage(`Free demo is enabled for ${data.demoDays} days.`);
        } else if (data.paidSubscriptionsEnabled) {
          setStatusMessage("Choose SOL or USDT on Solana to activate 30-day access.");
        } else {
          setStatusMessage("Access activation is currently disabled by the administrator.");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to load subscription settings.";
        setError(message);
        setStatusMessage("Subscription checkout is temporarily unavailable.");
      }
    })();
  }, [webApp]);

  useEffect(() => {
    if (!canCheckout || paid) return;

    void (async () => {
      try {
        const response = await fetch("/api/miniapp/access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
          cache: "no-store",
        });
        if (response.status === 404) return;

        const data = (await response.json()) as VerifyPaymentResponse;
        if (!response.ok) throw new Error(data.error || "Unable to restore active access.");
        if (
          data.status !== "paid" ||
          !data.payload ||
          !data.login ||
          !data.password ||
          data.password.length !== 32
        ) {
          throw new Error("Stored access credentials are incomplete.");
        }

        setLogin(data.login);
        setOrder({
          payload: data.payload,
          login: data.login,
          status: "paid",
          password: data.password,
          subscriptionExpiresAt: data.subscriptionExpiresAt,
        });
        setCheckout(null);
        setError("");
        setStatusMessage("Active access restored. You can copy your login and password below.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to restore active access.";
        setError(message);
      }
    })();
  }, [canCheckout, initData, paid]);

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
      if (!LOGIN_RE.test(login)) throw new Error("Enter a valid login first.");
      if (!canCheckout) throw new Error("Open this Mini App from Telegram to activate access.");

      webApp?.HapticFeedback?.impactOccurred?.("light");
      setStatusMessage(method === "DEMO" ? "Activating free demo…" : `Creating ${method} payment request…`);

      const response = await fetch("/api/miniapp/create-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, login, method }),
      });
      const data = (await response.json()) as CheckoutResponse;
      if (!response.ok) throw new Error(data.error || "Could not create subscription checkout.");
      if (!data.payload) throw new Error("Subscription order was not created correctly.");

      if (data.mode === "DEMO") {
        if (!data.password || data.password.length !== 32 || !data.login) {
          throw new Error("Demo access credentials were not generated correctly.");
        }
        setOrder({
          payload: data.payload,
          login: data.login,
          status: "paid",
          password: data.password,
          subscriptionExpiresAt: data.subscriptionExpiresAt,
        });
        setStatusMessage("Free demo activated. Your login and 32-character password are ready.");
        webApp?.HapticFeedback?.notificationOccurred?.("success");
        return;
      }

      if (!data.currency || !data.displayAmount || !data.paymentUrl) {
        throw new Error("Solana payment request was not created correctly.");
      }
      setCheckout({
        payload: data.payload,
        currency: data.currency,
        displayAmount: data.displayAmount,
        paymentUrl: data.paymentUrl,
      });
      setStatusMessage(
        `Send exactly ${data.displayAmount} ${data.currency} using the Solana Pay button. Confirmation is checked automatically.`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Checkout error.";
      setError(message);
      setStatusMessage("Checkout needs attention.");
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
        if (showPending) setStatusMessage("Payment is not confirmed yet. Waiting for the Solana transaction…");
        return;
      }
      if (!response.ok) throw new Error(data.error || "Unable to verify payment.");
      if (
        data.status !== "paid" ||
        !data.payload ||
        !data.login ||
        !data.password ||
        data.password.length !== 32
      ) {
        throw new Error("Payment confirmation is incomplete.");
      }

      setOrder({
        payload: data.payload,
        login: data.login,
        status: "paid",
        password: data.password,
        subscriptionExpiresAt: data.subscriptionExpiresAt,
        paymentSignature: data.paymentSignature,
      });
      setCheckout(null);
      setStatusMessage("Payment confirmed on Solana. Your login and 32-character password are ready.");
      webApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch (err) {
      if (showPending) {
        const message = err instanceof Error ? err.message : "Unable to verify payment.";
        setError(message);
        webApp?.HapticFeedback?.notificationOccurred?.("error");
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  async function copy(value: string, key: "login" | "password" | "payment") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      webApp?.HapticFeedback?.notificationOccurred?.("success");
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      setError("Could not copy automatically. Press and hold the value to copy it.");
    }
  }

  function openPayment() {
    if (!checkout?.paymentUrl) return;
    webApp?.HapticFeedback?.impactOccurred?.("medium");
    window.location.href = checkout.paymentUrl;
  }

  return (
    <main className="relative min-h-[100dvh] overflow-x-hidden bg-[#06100c] text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-24 -top-20 h-72 w-72 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="absolute -right-28 top-64 h-80 w-80 rounded-full bg-cyan-400/10 blur-3xl" />
      </div>

      <section className="relative mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col gap-4 px-4 pb-8 pt-4 sm:px-5 sm:pt-5">
        <header className="flex items-center justify-between gap-3 rounded-3xl border border-white/10 bg-white/[0.045] p-3 backdrop-blur-xl">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-[#06100c]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[10px] font-semibold uppercase tracking-[0.25em] text-white/45">Soft777 Mini App</p>
              <h1 className="truncate text-lg font-bold tracking-tight">Solana Launcher Pro</h1>
            </div>
          </div>
          <div className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${isTelegram ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-200" : "border-amber-300/25 bg-amber-300/10 text-amber-100"}`}>
            {isTelegram ? "Connected" : "Preview"}
          </div>
        </header>

        <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="rounded-[28px] border border-white/10 bg-gradient-to-br from-white/[0.075] to-white/[0.025] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300/65">Premium access</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight">Welcome, {displayName}</h2>
              <p className="mt-2 text-sm leading-6 text-white/62">
                Choose your own site login. After demo activation or verified payment, the backend generates a unique 32-character password and stores the account securely.
              </p>
            </div>
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 text-emerald-200">
              <ShieldCheck className="h-5 w-5" />
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            <Metric label="SOL" value={solEnabled ? `${config?.monthlyPriceSol}` : "Off"} />
            <Metric label="USDT" value={usdtEnabled ? `${config?.monthlyPriceUsdt}` : "Off"} />
            <Metric label="Demo" value={config?.freeDemoEnabled ? `${config.demoDays} days` : "Off"} />
          </div>
        </motion.section>

        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-5 text-white/72">
          {statusMessage}
        </div>

        {paid && order ? (
          <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="rounded-[28px] border border-emerald-300/25 bg-emerald-300/[0.08] p-5">
            <div className="flex items-center gap-3 text-emerald-100">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-300/15"><Check className="h-5 w-5" /></div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/65">Activated</p>
                <h2 className="text-lg font-bold">Your access is ready</h2>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <CredentialRow label="Login" value={order.login} copied={copied === "login"} onCopy={() => copy(order.login, "login")} />
              <CredentialRow label="Password" value={order.password || ""} copied={copied === "password"} onCopy={() => copy(order.password || "", "password")} />
            </div>

            <p className="mt-3 text-xs leading-5 text-white/50">
              Save these credentials. The password contains exactly 32 characters and was generated by the backend.
            </p>

            {order.subscriptionExpiresAt && (
              <p className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/55">
                Access valid until {new Date(order.subscriptionExpiresAt).toLocaleDateString()}.
              </p>
            )}

            <a href="/login" className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-300 px-4 py-3 text-sm font-black text-[#06100c]">
              Войти на сайт <ArrowRight className="h-4 w-4" />
            </a>

            {config?.paidSubscriptionsEnabled && (
              <div className="mt-4 border-t border-white/10 pt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
                  Extend access by 30 days
                </p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <PaymentButton
                    label={solEnabled ? `Pay ${config.monthlyPriceSol} SOL` : "SOL unavailable"}
                    disabled={loading || !solEnabled || !config.recipientConfigured || !canCheckout}
                    loading={loading}
                    onClick={() => createCheckout("SOL")}
                  />
                  <PaymentButton
                    label={usdtEnabled ? `Pay ${config.monthlyPriceUsdt} USDT` : "USDT unavailable"}
                    disabled={loading || !usdtEnabled || !config.recipientConfigured || !canCheckout}
                    loading={loading}
                    onClick={() => createCheckout("USDT")}
                  />
                </div>
                {!config.recipientConfigured && (
                  <p className="mt-2 text-xs leading-5 text-white/45">
                    Paid renewal is temporarily unavailable until the payment wallet is configured.
                  </p>
                )}
              </div>
            )}
          </motion.section>
        ) : checkout ? (
          <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="rounded-[28px] border border-cyan-300/20 bg-cyan-300/[0.06] p-5">
            <div className="flex items-start gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-100"><CreditCard className="h-5 w-5" /></div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200/60">Solana payment</p>
                <h2 className="text-lg font-bold">{checkout.displayAmount} {checkout.currency}</h2>
                <p className="mt-1 text-sm leading-5 text-white/55">Use the payment request below so the unique order reference is included on-chain.</p>
              </div>
            </div>

            <button type="button" onClick={openPayment} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-300 to-cyan-300 px-4 py-3.5 text-sm font-black text-[#06100c] active:scale-[0.99]">
              Open in Solana wallet <ArrowRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => copy(checkout.paymentUrl, "payment")} className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/80">
              {copied === "payment" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied === "payment" ? "Payment link copied" : "Copy Solana Pay link"}
            </button>
            <button type="button" disabled={checking} onClick={() => verifyPayment(checkout.payload, true)} className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.08] px-4 py-3 text-sm font-semibold text-emerald-100 disabled:opacity-50">
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              I paid — verify transaction
            </button>
          </motion.section>
        ) : (
          <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/[0.06] text-white/80 ring-1 ring-white/10"><UserRound className="h-5 w-5" /></div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/40">Step 1</p>
                <h2 className="text-lg font-bold">Choose your site login</h2>
                <p className="mt-1 text-sm leading-5 text-white/55">You choose the login. The backend creates the 32-character password automatically after activation.</p>
              </div>
            </div>

            <label className="mt-5 block">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">Login</span>
              <div className="mt-2 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-3 focus-within:border-emerald-300/50">
                <UserRound className="h-4 w-4 shrink-0 text-white/35" />
                <input value={login} onChange={(event) => setLogin(event.target.value)} maxLength={32} autoComplete="username" inputMode="text" placeholder="for example dima_pro" className="min-w-0 flex-1 bg-transparent py-3.5 text-base text-white outline-none placeholder:text-white/25" />
              </div>
            </label>

            {loginError && <p className="mt-2 text-sm text-amber-200">{loginError}</p>}
            {!isTelegram && process.env.NODE_ENV === "production" && (
              <p className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2.5 text-sm leading-5 text-amber-100">Activation is available only when this page is opened from the Telegram bot.</p>
            )}
            {error && <p className="mt-3 rounded-2xl border border-red-300/20 bg-red-400/[0.08] px-3 py-2.5 text-sm leading-5 text-red-100">{error}</p>}

            {config?.freeDemoEnabled && (
              <button type="button" onClick={() => createCheckout("DEMO")} disabled={loading || Boolean(loginError) || !login || !canCheckout} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-300 to-cyan-300 px-4 py-3.5 text-sm font-black text-[#06100c] disabled:cursor-not-allowed disabled:opacity-40">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Activate free {config.demoDays}-day demo
              </button>
            )}

            {config?.paidSubscriptionsEnabled && (
              <div className={`${config.freeDemoEnabled ? "mt-3" : "mt-5"} grid grid-cols-1 gap-2 sm:grid-cols-2`}>
                <PaymentButton label={solEnabled ? `Pay ${config.monthlyPriceSol} SOL` : "SOL unavailable"} disabled={loading || !solEnabled || !config.recipientConfigured || Boolean(loginError) || !login || !canCheckout} loading={loading} onClick={() => createCheckout("SOL")} />
                <PaymentButton label={usdtEnabled ? `Pay ${config.monthlyPriceUsdt} USDT` : "USDT unavailable"} disabled={loading || !usdtEnabled || !config.recipientConfigured || Boolean(loginError) || !login || !canCheckout} loading={loading} onClick={() => createCheckout("USDT")} />
              </div>
            )}

            {config && !config.freeDemoEnabled && !config.paidSubscriptionsEnabled && (
              <p className="mt-5 rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm leading-5 text-white/55">
                Demo and paid access are currently disabled in the admin panel.
              </p>
            )}

            {config?.paidSubscriptionsEnabled && !config.recipientConfigured && (
              <p className="mt-3 text-xs leading-5 text-white/45">Payment destination is not configured yet. Set the recipient wallet in the admin subscription settings.</p>
            )}
          </motion.section>
        )}

        <div className="grid grid-cols-3 gap-2 text-[11px] text-white/45">
          <TrustItem icon={<LockKeyhole className="h-4 w-4" />} text="Backend password" />
          <TrustItem icon={<ShieldCheck className="h-4 w-4" />} text="On-chain verification" />
          <TrustItem icon={<KeyRound className="h-4 w-4" />} text="Private credentials" />
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-3"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35">{label}</p><p className="mt-1 truncate text-sm font-bold text-white/85">{value}</p></div>;
}

function PaymentButton({ label, disabled, loading, onClick }: { label: string; disabled: boolean; loading: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} disabled={disabled} className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-300 to-cyan-300 px-4 py-3.5 text-sm font-black text-[#06100c] disabled:cursor-not-allowed disabled:opacity-35">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}{label}</button>;
}

function CredentialRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return <div className="rounded-2xl border border-white/10 bg-black/25 p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.17em] text-white/35">{label}</p><div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-sm text-white/85">{value}</code><button type="button" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`} title={`Copy ${label.toLowerCase()}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.05] text-white/70">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</button></div></div>;
}

function TrustItem({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.025] px-2 py-2 text-center">{icon}<span>{text}</span></div>;
}
