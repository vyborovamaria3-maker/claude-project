"use client";

import { useEffect, useState } from "react";
import { Bot, RefreshCw, Shield } from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

type SessionState = "checking" | "connected" | "disconnected" | "unknown";

/**
 * This release has one owner-scoped MTProto session vault, not a multi-account
 * automation fleet. Never render fake accounts, invite totals or proxy settings.
 */
export default function MultiAccountPanel() {
  const [status, setStatus] = useState<SessionState>("checking");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/tginvite/mtproto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "connect" }),
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        const data: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (response.ok && data && typeof data === "object" &&
            (data as { status?: unknown }).status === "connected") {
          setStatus("connected");
        } else if (response.status === 400 && data && typeof data === "object" &&
                   (data as { error?: unknown }).error === "apiId and apiHash required for a new login") {
          setStatus("disconnected");
        } else {
          setStatus("unknown");
        }
      } catch {
        if (!controller.signal.aborted) setStatus("unknown");
      }
    })();
    return () => controller.abort();
  }, [refresh]);

  const statusLabel = {
    checking: "Checking session…",
    connected: "MTProto session connected",
    disconnected: "No active MTProto session",
    unknown: "Unable to verify session",
  }[status];

  return (
    <section className="space-y-6" aria-label="TGInvite Telegram account status">
      <div className={siteDesign.page.panelClassName}>
        <h2 className="flex items-center gap-2 text-xl font-bold">
          <Bot className="h-5 w-5 text-[color:var(--theme-primary)]" />
          Telegram account connection
        </h2>
        <p className="mt-2 text-sm text-content-muted">
          TGInvite currently supports an owner-scoped MTProto session for parsing.
          A multi-account invitation pool, automatic account rotation, and automated
          direct-invite workers are not implemented.
        </p>
      </div>
      <div className={siteDesign.page.panelClassName}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-semibold">
              <Shield className="h-5 w-5" />
              Stored MTProto session
            </h3>
            <p className="mt-2 text-sm text-content-muted" role="status">{statusLabel}</p>
          </div>
          <button
            type="button"
            className={siteDesign.controls.actionButtonClassName}
            disabled={status === "checking"}
            onClick={() => { setStatus("checking"); setRefresh((value) => value + 1); }}
          >
            <RefreshCw className={`h-4 w-4 ${status === "checking" ? "animate-spin" : ""}`} />
            Check again
          </button>
        </div>
        <p className="mt-4 text-xs text-content-muted">
          Connect or disconnect your Telegram account through the TGInvite Settings tab.
          Session secrets are managed on the server, not displayed here. This screen
          does not issue invitations or infer Telegram limits.
        </p>
      </div>
    </section>
  );
}
