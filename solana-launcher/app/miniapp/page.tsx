"use client";

import { useEffect, useMemo, useState } from "react";
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
  openInvoice?: (url: string, callback?: (status: string) => void) => void;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
  };
};

type OrderState = {
  payload: string;
  login: string;
  status: "pending" | "paid";
  password: string | null;
  subscriptionExpiresAt?: string | null;
};

type CreateInvoiceResponse = {
  error?: string;
  payload?: string;
  invoiceLink?: string;
  currency?: "XTR";
  totalAmount?: number;
  reused?: boolean;
};

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;

export default function MiniAppPage() {
  const [login, setLogin] = useState("");
  const [payload, setPayload] = useState("");
  const [invoiceLink, setInvoiceLink] = useState("");
  const [invoiceAmountStars, setInvoiceAmountStars] = useState<number | null>(null);
  const [order, setOrder] = useState<OrderState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<"login" | "password" | null>(null);
  const [telegramUser, setTelegramUser] = useState<TelegramUser | null>(null);
  const [statusMessage, setStatusMessage] = useState("Preparing secure checkout…");

  const webApp =
    typeof window !== "undefined" ? (window.Telegram?.WebApp as MiniAppWebApp | undefined) : undefined;
  const initData = webApp?.initData || "";
  const isTelegram = Boolean(initData);
  const canCreateInvoice = isTelegram || process.env.NODE_ENV !== "production";
  const paid = order?.status === "paid" && Boolean(order.password);

  const loginError = useMemo(() => {
    if (!login) return "";
    return LOGIN_RE.test(login) ? "" : "Use 4-32 characters: letters, digits, or underscore.";
  }, [login]);

  const displayName = telegramUser?.first_name || telegramUser?.username || "Trader";

  useEffect(() => {
    if (!webApp) {
      setStatusMessage("Browser preview. Open the Mini App from Telegram to pay.");
      return;
    }

    webApp.ready?.();
    webApp.expand?.();
    webApp.setHeaderColor?.("#06100c");
    webApp.setBackgroundColor?.("#06100c");
    setTelegramUser(webApp.initDataUnsafe?.user || null);
    setStatusMessage(
      webApp.initData
        ? "Telegram connected. Choose your site login to continue."
        : "Browser preview. Open the Mini App from Telegram to pay."
    );
  }, [webApp]);

  useEffect(() => {
    if (!payload || order?.status === "paid") return;

    const id = window.setInterval(() => {
      void refreshOrder(payload);
    }, 2000);

    return () => window.clearInterval(id);
  }, [payload, order?.status]);

  useEffect(() => {
    if (order?.status !== "paid") return;
    setStatusMessage("Payment confirmed. Your access credentials are ready.");
    webApp?.HapticFeedback?.notificationOccurred?.("success");
  }, [order?.status, webApp]);

  async function refreshOrder(payloadValue: string) {
    const response = await fetch(`/api/miniapp/order?payload=${encodeURIComponent(payloadValue)}`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = (await response.json()) as OrderState;
    setOrder(data);
  }

  async function createInvoice() {
    setError("");
    setLoading(true);
    setOrder(null);
    setInvoiceLink("");
    setInvoiceAmountStars(null);

    try {
      if (!LOGIN_RE.test(login)) {
        throw new Error("Enter a valid login first.");
      }
      if (!canCreateInvoice) {
        throw new Error("Open this Mini App from Telegram to create a payment.");
      }

      webApp?.HapticFeedback?.impactOccurred?.("light");
      setStatusMessage("Creating a secure Telegram Stars invoice…");

      const response = await fetch("/api/miniapp/create-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, login }),
      });
      const data = (await response.json()) as CreateInvoiceResponse;

      if (!response.ok) {
        throw new Error(data.error || "Could not create the Telegram Stars invoice.");
      }
      if (!data.payload || !data.invoiceLink || data.currency !== "XTR" || !data.totalAmount) {
        throw new Error("The Telegram Stars payment order was not created correctly.");
      }

      setPayload(data.payload);
      setInvoiceLink(data.invoiceLink);
      setInvoiceAmountStars(data.totalAmount);
      setStatusMessage(
        data.reused
          ? `Existing invoice ready: ${data.totalAmount} Telegram Stars.`
          : `Invoice ready: ${data.totalAmount} Telegram Stars.`
      );

      webApp?.openInvoice?.(data.invoiceLink, (status) => {
        if (status === "paid") {
          setStatusMessage("Payment received. Activating your access…");
          void refreshOrder(data.payload as string);
        } else if (status === "cancelled") {
          setStatusMessage("Payment cancelled. You can open the invoice again when ready.");
        } else if (status === "failed") {
          setStatusMessage("Telegram reported a payment failure. Please try again.");
          webApp?.HapticFeedback?.notificationOccurred?.("error");
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Payment error.";
      setError(message);
      setStatusMessage("Checkout needs attention.");
      webApp?.HapticFeedback?.notificationOccurred?.("error");
    } finally {
      setLoading(false);
    }
  }

  async function copy(value: string, key: "login" | "password") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      webApp?.HapticFeedback?.notificationOccurred?.("success");
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      setError("Could not copy automatically. Press and hold the value to copy it.");
    }
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
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-300 to-cyan-400 text-[#06100c] shadow-[0_14px_40px_rgba(52,211,153,0.18)]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[10px] font-semibold uppercase tracking-[0.25em] text-white/45">Soft777 Mini App</p>
              <h1 className="truncate text-lg font-bold tracking-tight">Solana Launcher Pro</h1>
            </div>
          </div>
          <div
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              isTelegram
                ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-200"
                : "border-amber-300/25 bg-amber-300/10 text-amber-100"
            }`}
          >
            {isTelegram ? "Connected" : "Preview"}
          </div>
        </header>

        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br from-white/[0.075] to-white/[0.025] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.22)]"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300/65">Premium access</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight">Welcome, {displayName}</h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-white/62">
                Activate 30-day access from Telegram and receive your site login credentials after payment confirmation.
              </p>
            </div>
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 text-emerald-200">
              <ShieldCheck className="h-5 w-5" />
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            <Metric
              label="Price"
              value={invoiceAmountStars ? `${invoiceAmountStars} Stars` : "Telegram Stars"}
            />
            <Metric label="Access" value="30 days" />
            <Metric label="Delivery" value="Telegram" />
          </div>
        </motion.section>

        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-5 text-white/72">
          {statusMessage}
        </div>

        {paid && order ? (
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-[28px] border border-emerald-300/25 bg-emerald-300/[0.08] p-5"
          >
            <div className="flex items-center gap-3 text-emerald-100">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-300/15">
                <Check className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300/65">Activated</p>
                <h2 className="text-lg font-bold">Your access is ready</h2>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              <CredentialRow
                label="Login"
                value={order.login}
                copied={copied === "login"}
                onCopy={() => copy(order.login, "login")}
              />
              <CredentialRow
                label="Password"
                value={order.password || ""}
                copied={copied === "password"}
                onCopy={() => copy(order.password || "", "password")}
              />
            </div>

            {order.subscriptionExpiresAt && (
              <p className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/55">
                Access valid until {new Date(order.subscriptionExpiresAt).toLocaleDateString()}.
              </p>
            )}

            <a
              href="/login"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-300 px-4 py-3 text-sm font-black text-[#06100c] transition active:scale-[0.99]"
            >
              Open site login
              <ArrowRight className="h-4 w-4" />
            </a>
          </motion.section>
        ) : (
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 backdrop-blur-xl"
          >
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/[0.06] text-white/80 ring-1 ring-white/10">
                <UserRound className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/40">Step 1</p>
                <h2 className="text-lg font-bold">Choose your site login</h2>
                <p className="mt-1 text-sm leading-5 text-white/55">This login will be paired with the password generated after payment.</p>
              </div>
            </div>

            <label className="mt-5 block">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white/45">Login</span>
              <div className="mt-2 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-3 focus-within:border-emerald-300/50">
                <UserRound className="h-4 w-4 shrink-0 text-white/35" />
                <input
                  value={login}
                  onChange={(event) => setLogin(event.target.value)}
                  maxLength={32}
                  autoComplete="username"
                  inputMode="text"
                  placeholder="for example dima_pro"
                  className="min-w-0 flex-1 bg-transparent py-3.5 text-base text-white outline-none placeholder:text-white/25"
                />
              </div>
            </label>

            {loginError && <p className="mt-2 text-sm text-amber-200">{loginError}</p>}
            {!isTelegram && process.env.NODE_ENV === "production" && (
              <p className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/[0.08] px-3 py-2.5 text-sm leading-5 text-amber-100">
                Payment is available only when this page is opened from the Telegram bot.
              </p>
            )}
            {error && (
              <p className="mt-3 rounded-2xl border border-red-300/20 bg-red-400/[0.08] px-3 py-2.5 text-sm leading-5 text-red-100">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={createInvoice}
              disabled={loading || Boolean(loginError) || !login || !canCreateInvoice}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-300 to-cyan-300 px-4 py-3.5 text-sm font-black text-[#06100c] shadow-[0_16px_48px_rgba(52,211,153,0.18)] transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
              {loading ? "Creating invoice…" : "Pay with Telegram Stars"}
            </button>

            {invoiceLink && (
              <a
                href={invoiceLink}
                target="_blank"
                rel="noreferrer"
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-300/25 bg-emerald-300/[0.06] px-4 py-3 text-sm font-semibold text-emerald-100"
              >
                Open Telegram Stars invoice
                <ArrowRight className="h-4 w-4" />
              </a>
            )}
          </motion.section>
        )}

        <section className="rounded-[28px] border border-white/10 bg-black/15 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/40">How it works</p>
          <div className="mt-4 grid gap-3">
            <FlowStep icon={UserRound} number="01" title="Choose login" text="Use 4-32 letters, digits, or underscore." />
            <FlowStep icon={CreditCard} number="02" title="Pay with Stars" text="Digital access is purchased through Telegram Stars inside the app." />
            <FlowStep icon={KeyRound} number="03" title="Receive access" text="After confirmation, your password appears here and in the bot." />
          </div>
        </section>

        <div className="flex items-center justify-center gap-2 pb-2 text-xs text-white/35">
          <LockKeyhole className="h-3.5 w-3.5" />
          Payment and access are processed server-side.
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-black/20 px-2 py-3 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/35">{label}</p>
      <p className="mt-1 truncate text-sm font-bold text-white/90">{value}</p>
    </div>
  );
}

function FlowStep({
  icon: Icon,
  number,
  title,
  text,
}: {
  icon: typeof UserRound;
  number: string;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/[0.055] ring-1 ring-white/10">
        <Icon className="h-4 w-4 text-emerald-200" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold tracking-[0.18em] text-emerald-300/55">{number}</span>
          <p className="text-sm font-semibold">{title}</p>
        </div>
        <p className="mt-1 text-xs leading-5 text-white/48">{text}</p>
      </div>
    </div>
  );
}

function CredentialRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-sm text-white">{value}</code>
        <button
          type="button"
          onClick={onCopy}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-white/70"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
