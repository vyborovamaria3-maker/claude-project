"use client";

import { useEffect, useMemo, useState } from "react";
import { Bell, Globe, CheckCircle2, AlertTriangle, Menu } from "lucide-react";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { useI18n } from "@/components/providers/I18nProvider";
import { siteDesign } from "@/lib/siteDesign";

type RpcStatus = "checking" | "ok" | "degraded";

function useRpcHealth() {
  const [status, setStatus] = useState<RpcStatus>("checking");
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const rpc = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";
        const start = Date.now();
        const r = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
          signal: AbortSignal.timeout(5000),
        });
        const elapsed = Date.now() - start;

        if (cancelled) return;
        setStatus(r.ok && elapsed < 4000 ? "ok" : "degraded");
        setLatency(elapsed);
      } catch {
        if (cancelled) return;
        setStatus("degraded");
        setLatency(null);
      }
    }

    check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { status, latency };
}

export default function Header({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const { status: rpcStatus, latency } = useRpcHealth();
  const { t } = useI18n();

  const statusBanner = useMemo(() => {
    if (rpcStatus === "degraded") {
      return (
        <div
          data-tag="system.status_banner"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-warning-border bg-warning-soft px-2.5 py-2 text-warning shadow-surface-soft sm:gap-3 sm:px-3 sm:py-2.5"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 truncate text-xs">
            <span className="font-semibold text-warning">{t("header.rpcDegraded.title")}</span>{" "}
            <span className="hidden sm:inline text-content-muted">{t("header.rpcDegraded.body")}</span>
          </div>
        </div>
      );
    }

    return (
      <div
        data-tag="system.status_banner"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-success-border bg-success-soft px-2.5 py-2 text-success shadow-surface-soft sm:gap-3 sm:px-3 sm:py-2.5"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        <div className="min-w-0 truncate text-xs">
          <span className="font-semibold text-success">
            {rpcStatus === "checking" ? t("header.rpcChecking") : t("header.rpcOk.title")}
          </span>{" "}
          <span className="hidden sm:inline text-content-muted">{rpcStatus === "ok" && t("header.rpcOk.body")}</span>
        </div>
      </div>
    );
  }, [rpcStatus, t]);

  return (
    <header
      data-tag="layout.header"
      className={siteDesign.header.shellClassName}
    >
      <div className={siteDesign.header.innerClassName}>
        <button
          type="button"
          onClick={onMenuToggle}
          className={`${siteDesign.buttonClasses.icon} flex h-10 w-10 shrink-0 items-center justify-center lg:hidden`}
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>

        {statusBanner}

        {latency !== null && (
          <div className="hidden md:flex items-center gap-2 text-xs text-content-muted">
            <Globe className="w-4 h-4" />
            <span className={latency < 200 ? "text-success" : latency < 500 ? "text-warning" : "text-danger"}>
              {latency}ms
            </span>
          </div>
        )}

        <button className={`${siteDesign.buttonClasses.icon} shrink-0`} aria-label={t(siteDesign.header.notificationAriaKey as Parameters<typeof t>[0])}>
          <Bell className="w-4 h-4" />
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary shadow-neon-green" />
        </button>

        <div className="hidden md:flex items-center gap-2 text-xs rounded-full border border-bg-border bg-bg-card/50 px-3 py-1.5">
          <span
            className={[
              "w-2 h-2 rounded-full",
              rpcStatus === "ok" ? "bg-success animate-pulse-soft" : rpcStatus === "degraded" ? "bg-warning" : "bg-content-faint",
            ].join(" ")}
          />
          <span className="text-content-soft">
            {rpcStatus === "ok" ? t("header.connected") : rpcStatus === "degraded" ? t("header.degraded") : t("header.checking")}
          </span>
          <LanguageSwitcher />
        </div>
      </div>
    </header>
  );
}
