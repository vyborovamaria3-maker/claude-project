"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { ArrowRight, CheckCircle2, Lock, Sparkles, ShieldCheck, Key } from "lucide-react";
import { useI18n } from "@/components/providers/I18nProvider";
import PasswordLoginForm from "@/components/PasswordLoginForm";

type TokenResponse = {
  access_token: string;
  expires_in: number;
};

type TelegramWebApp = {
  initData: string;
  ready?: () => void;
};

type AuthWindow = Window & {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
};

const authPoints = ["login.point1", "login.point2", "login.point3"] as const;

function getTelegramLaunchUrls(botUrl: string) {
  const fallbackUrl = botUrl.trim();

  try {
    const parsed = new URL(fallbackUrl);
    const domain = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    if (!domain) {
      return { fallbackUrl, appUrl: fallbackUrl };
    }

    const params = parsed.searchParams.toString();
    return {
      fallbackUrl,
      appUrl: `tg://resolve?domain=${domain}${params ? `&${params}` : ""}`,
    };
  } catch {
    return { fallbackUrl, appUrl: fallbackUrl };
  }
}

function saveToken(payload: TokenResponse) {
  localStorage.setItem("potapoff.access_token", payload.access_token);
  localStorage.setItem(
    "potapoff.auth_meta",
    JSON.stringify({ access_token: payload.access_token, expires_in: payload.expires_in, saved_at: Date.now() })
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const telegramReady = typeof window !== "undefined" && Boolean((window as AuthWindow).Telegram?.WebApp);

  const telegramBotUrl = process.env.NEXT_PUBLIC_TELEGRAM_BOT_URL || "https://t.me/Soft777bot";

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    if (token) {
      saveToken({ access_token: token, expires_in: 86400 });
      setSuccess(t("login.success"));
      router.replace("/");
      router.refresh();
    }
  }, [router, t]);

  async function handleTelegramAuth() {
    setError(null);
    setSuccess(null);

    try {
      if (!telegramBotUrl || telegramBotUrl.includes("your_bot_username")) {
        throw new Error("Telegram bot URL is not configured");
      }

      const { appUrl, fallbackUrl } = getTelegramLaunchUrls(telegramBotUrl);
      const fallbackTimer = window.setTimeout(() => {
        if (!document.hidden) {
          window.location.replace(fallbackUrl);
        }
      }, 250);

      const stopFallback = () => {
        window.clearTimeout(fallbackTimer);
        document.removeEventListener("visibilitychange", stopFallback);
      };

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          stopFallback();
        }
      }, { once: true });

      window.location.href = appUrl;
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : t("login.telegramError"));
    }
  }

  return (
    <div className="min-h-screen min-w-0 overflow-x-hidden">
      <div className="mx-auto grid min-h-screen min-w-0 w-full max-w-7xl items-center gap-8 px-3 py-4 sm:gap-10 sm:px-8 sm:py-6 lg:grid-cols-[0.92fr_1.08fr] lg:px-10">
        <section className="min-w-0 max-w-2xl">
          <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-neon-green/25 bg-neon-green/10 px-3 py-2 text-[11px] font-semibold text-neon-green sm:px-4 sm:text-xs">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{t("login.badge")}</span>
          </div>

          <h1 className="mt-5 break-words text-3xl font-black leading-[1.05] tracking-tight text-white sm:mt-6 sm:text-5xl lg:text-6xl">
            {t("login.title")}
          </h1>

          <p className="mt-4 max-w-xl break-words text-sm leading-6 text-white/55 sm:mt-5 sm:text-lg sm:leading-7">
            {t("login.description")}
          </p>

          <div className="mt-7 space-y-3 sm:mt-8">
            {authPoints.map((item) => (
              <div key={item} className="flex min-w-0 items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-neon-green" />
                <span className="min-w-0 break-words text-sm leading-6 text-white/65">{t(item)}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="auth-form" className="relative min-w-0">
          <div className="absolute inset-0 -z-10 rounded-[2rem] bg-[radial-gradient(circle_at_top_left,rgba(244,63,94,0.25),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(192,132,252,0.18),transparent_34%)] blur-2xl" />
          <div className="min-w-0 rounded-2xl border border-white/10 bg-black/25 p-3 shadow-2xl backdrop-blur-xl sm:rounded-[2rem] sm:p-6">
            <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:rounded-[1.5rem] sm:p-6">
              <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-neon-green/25 bg-neon-green/10 px-3 py-1 text-xs font-semibold text-neon-green">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{t("login.formBadge")}</span>
                  </div>
                  <h2 className="mt-4 break-words text-xl font-bold text-white sm:text-2xl">{t("login.telegramPanelTitle")}</h2>
                  <p className="mt-2 break-words text-sm leading-6 text-white/45">
                    {t("login.formDescription")}
                  </p>
                </div>
                <div className="w-fit shrink-0 rounded-2xl border border-white/10 bg-black/20 p-3 text-neon-green">
                  <Lock className="h-5 w-5" />
                </div>
              </div>

              <div className="mt-6 grid min-w-0 gap-3 sm:grid-cols-2">
                {[
                  { label: "Telegram", description: "Авторизация через бота" },
                  { label: "Пароль", description: "Вход по 32-символьному паролю" },
                ].map((tab) => (
                  <button
                    key={tab.label}
                    type="button"
                    disabled
                    aria-disabled="true"
                    className="min-w-0 rounded-2xl border border-neon-green/40 bg-neon-green/10 px-4 py-4 text-left text-sm font-semibold text-white transition"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {tab.label === "Telegram" ? <MessageCircleIcon /> : <Key className="h-4 w-4 shrink-0" />}
                      <span className="min-w-0 break-words">{tab.label}</span>
                    </div>
                    <p className="mt-2 break-words text-xs leading-5 text-white/45">{tab.description}</p>
                  </button>
                ))}
              </div>

              <p className="mt-3 break-words text-sm font-medium text-white/70">
                {t("login.telegramSubscriptionHint")}
              </p>

              <div className="mt-6 min-w-0 rounded-2xl border border-white/10 bg-black/20 p-3 sm:p-4">
                <div className="min-w-0 space-y-3">
                  <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-white">{t("login.telegramPanelTitle")}</p>
                      <p className="mt-1 break-words text-xs leading-5 text-white/45">{t("login.telegramPanelDescription")}</p>
                    </div>
                    <div className="w-fit max-w-full shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/60">
                      {telegramReady ? t("login.telegramReady") : t("login.telegramUnavailable")}
                    </div>
                  </div>

                  <PasswordLoginForm />

                  <div className="space-y-1">
                    <p className="break-words text-xs leading-5 text-white/50">
                      {t("login.telegramHint")}
                    </p>
                    <button
                      type="button"
                      onClick={handleTelegramAuth}
                      className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-neon-green px-4 py-3 text-center text-sm font-semibold text-black transition hover:scale-[1.01] sm:px-5 sm:py-3.5"
                    >
                      <ArrowRight className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 break-words">{t("login.continueTelegram")}</span>
                    </button>
                  </div>
                </div>
              </div>

              {error && (
                <div className="mt-4 break-words rounded-2xl border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger">
                  {error}
                </div>
              )}

              {success && (
                <div className="mt-4 break-words rounded-2xl border border-success-border bg-success-soft px-4 py-3 text-sm text-success">
                  {success}
                </div>
              )}

              <div className="mt-5">
                <Link
                  href="/auth"
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white/5 px-4 py-3 text-center text-sm font-semibold text-white transition hover:border-white/20 hover:bg-white/8 sm:w-auto"
                >
                  <span className="min-w-0 break-words">{t("login.viewLanding")}</span>
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function MessageCircleIcon() {
  return <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/20 text-[10px] font-black text-neon-green">T</span>;
}
