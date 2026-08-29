"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

declare global {
  interface Window {
    onTelegramAuth?: (user: Record<string, unknown>) => void;
  }
}

export function TelegramLoginButton({ onAuthenticated }: { onAuthenticated: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isLocalDev, setIsLocalDev] = useState(true);
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";
  const publicWebUrl = process.env.NEXT_PUBLIC_WEB_URL ?? process.env.NEXT_PUBLIC_TELEGRAM_WEBAPP_URL ?? "";

  useEffect(() => {
    setIsLocalDev(
      typeof window !== "undefined" &&
        ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
    );
  }, []);

  useEffect(() => {
    window.onTelegramAuth = async (loginData) => {
      await apiFetch("/api/auth/telegram", {
        method: "POST",
        body: JSON.stringify({ loginData })
      });
      onAuthenticated();
    };

    if (isLocalDev || !botUsername || !ref.current || ref.current.hasChildNodes()) return;
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    ref.current.appendChild(script);
  }, [botUsername, isLocalDev, onAuthenticated]);

  if (isLocalDev || !botUsername) {
    return (
      <div className="rounded-2xl border border-line bg-slate-50 p-4 text-sm text-ink/80">
        <p className="font-semibold text-ink">Telegram login is hidden in local dev</p>
        <p className="mt-1 leading-6">
          The Telegram Login Widget only works on a public HTTPS domain. Open the app from your
          Telegram Mini App URL to use sign in.
        </p>
        {publicWebUrl && publicWebUrl.startsWith("https://") && (
          <Link
            href={publicWebUrl}
            className="mt-3 inline-flex items-center rounded-lg border border-ink px-3 py-2 text-sm font-semibold text-ink"
          >
            Open public version
          </Link>
        )}
      </div>
    );
  }

  return <div ref={ref} className="min-h-12" />;
}
