"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, CreditCard, Loader2, ShieldCheck } from "lucide-react";

type MiniAppWebApp = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
  openInvoice?: (url: string, callback?: (status: string) => void) => void;
};

type OrderState = {
  payload: string;
  login: string;
  status: "pending" | "paid";
  password: string | null;
};

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;

export default function MiniAppPage() {
  const [login, setLogin] = useState("");
  const [payload, setPayload] = useState("");
  const [invoiceLink, setInvoiceLink] = useState("");
  const [devCheckout, setDevCheckout] = useState(false);
  const [order, setOrder] = useState<OrderState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<"login" | "password" | null>(null);

  const webApp =
    typeof window !== "undefined" ? (window.Telegram?.WebApp as MiniAppWebApp | undefined) : undefined;
  const initData = webApp?.initData || "";
  const isTelegram = Boolean(initData);
  const loginError = useMemo(() => {
    if (!login) return "";
    return LOGIN_RE.test(login) ? "" : "Use 4-32 chars: letters, digits, or underscore.";
  }, [login]);

  useEffect(() => {
    webApp?.ready?.();
    webApp?.expand?.();
  }, [webApp]);

  useEffect(() => {
    if (!payload || order?.status === "paid") return;

    const id = window.setInterval(async () => {
      const response = await fetch(`/api/miniapp/order?payload=${encodeURIComponent(payload)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as OrderState;
      setOrder(data);
      if (data.status === "paid") {
        window.clearInterval(id);
      }
    }, 2000);

    return () => window.clearInterval(id);
  }, [payload, order?.status]);

  async function createInvoice() {
    setError("");
    setLoading(true);
    setOrder(null);
    setInvoiceLink("");
    setDevCheckout(false);

    try {
      if (!LOGIN_RE.test(login)) {
        throw new Error("Enter a valid login first.");
      }

      const response = await fetch("/api/miniapp/create-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, login }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not create the Telegram invoice.");
      }

      setPayload(data.payload);
      setInvoiceLink(data.invoiceLink || "");
      setDevCheckout(Boolean(data.devCheckout));

      if (data.invoiceLink) {
        webApp?.openInvoice?.(data.invoiceLink);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment error.");
    } finally {
      setLoading(false);
    }
  }

  async function completeDevPayment() {
    if (!payload) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/miniapp/dev-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not confirm the test payment.");
      }
      const orderResponse = await fetch(`/api/miniapp/order?payload=${encodeURIComponent(payload)}`);
      setOrder(await orderResponse.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirmation error.");
    } finally {
      setLoading(false);
    }
  }

  async function copy(value: string, key: "login" | "password") {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1200);
  }

  const paid = order?.status === "paid" && order.password;

  return (
    <main className="min-h-screen bg-[#07110d] text-white">
      <section className="mx-auto flex min-h-screen w-full max-w-md flex-col px-5 py-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-emerald-300/70">Soft777</p>
            <h1 className="mt-1 text-2xl font-black">Solana Launcher Pro</h1>
          </div>
          <div className="rounded-full border border-emerald-300/25 bg-emerald-300/10 p-3 text-emerald-300">
            <ShieldCheck className="h-5 w-5" />
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-white/60">Software subscription</span>
            <span className="text-3xl font-black">$1000</span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs text-white/55">
            <div className="rounded-md bg-black/25 px-2 py-2">30 days</div>
            <div className="rounded-md bg-black/25 px-2 py-2">Solana tools</div>
            <div className="rounded-md bg-black/25 px-2 py-2">Access key</div>
          </div>
        </div>

        {!paid ? (
          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="text-xs uppercase tracking-[0.2em] text-white/45">Login for site access</span>
              <input
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                maxLength={32}
                placeholder="for example rafael_pro"
                className="mt-2 w-full rounded-lg border border-white/10 bg-black/35 px-4 py-3 text-base text-white outline-none transition focus:border-emerald-300/60"
              />
            </label>

            {loginError && <p className="text-sm text-amber-300">{loginError}</p>}
            {!isTelegram && (
              <p className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                Dev preview is open outside Telegram. Real Telegram initData and invoice UI work inside the Mini App.
              </p>
            )}
            {error && (
              <p className="rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={createInvoice}
              disabled={loading || Boolean(loginError) || !login}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 py-3 font-black text-[#06100c] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
              Pay subscription
            </button>

            {invoiceLink && (
              <a
                href={invoiceLink}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg border border-emerald-300/25 px-4 py-3 text-center text-sm font-semibold text-emerald-200"
              >
                Open Telegram invoice
              </a>
            )}

            {devCheckout && (
              <button
                type="button"
                onClick={completeDevPayment}
                disabled={loading}
                className="w-full rounded-lg border border-white/12 bg-white/8 px-4 py-3 text-sm font-semibold text-white"
              >
                Dev: confirm payment
              </button>
            )}
          </div>
        ) : (
          <div className="mt-5 rounded-lg border border-emerald-300/25 bg-emerald-300/10 p-4">
            <div className="mb-4 flex items-center gap-2 text-emerald-200">
              <Check className="h-5 w-5" />
              <h2 className="text-lg font-bold">Access activated</h2>
            </div>

            <div className="space-y-3">
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

            <p className="mt-4 rounded-lg border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/75">
              Your access credentials are ready. Use them in the website login form outside Telegram.
            </p>
          </div>
        )}
      </section>
    </main>
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
    <div className="rounded-md border border-white/10 bg-black/30 p-3">
      <div className="mb-1 text-xs uppercase tracking-[0.18em] text-white/40">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all text-sm text-white">{value}</code>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md border border-white/10 p-2 text-white/70"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
