"use client";

import Link from "next/link";
import { ShieldCheck, Sparkles } from "lucide-react";
import { MiniAppAutoLogin } from "./MiniAppAutoLogin";
import { TelegramLoginButton } from "./TelegramLoginButton";
import { useSession } from "../lib/useSession";
import { WalletLinker } from "./WalletLinker";
import { PlanSelector } from "./PlanSelector";
import { SubscriptionStatusPanel } from "./SubscriptionStatusPanel";
import { PaymentHistory } from "./PaymentHistory";

export function DashboardPageClient({ isLocalDev }: { isLocalDev: boolean }) {
  const { user, loading, refresh } = useSession();

  return (
    <main className="min-h-screen">
      {!isLocalDev && <MiniAppAutoLogin onAuthenticated={refresh} />}
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-ocean">Solana subscriptions</p>
            <h1 className="text-3xl font-black tracking-normal text-ink">SolSub</h1>
          </div>
          <Link
            href="/dashboard/premium"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-ink px-4 text-sm font-bold"
          >
            <Sparkles className="h-4 w-4" />
            Premium
          </Link>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {!user && !isLocalDev && (
            <section className="border border-line bg-white p-5">
              <div className="mb-4 flex items-start gap-3">
                <ShieldCheck className="mt-1 h-5 w-5 text-mint" />
                <div>
                  <h2 className="text-xl font-extrabold">Sign in</h2>
                  <p className="text-sm leading-6 text-ink/70">
                    Open the app from the public HTTPS link to sign in and link your Solana wallet.
                  </p>
                </div>
              </div>
              <TelegramLoginButton onAuthenticated={refresh} />
            </section>
          )}

          {!user && isLocalDev && (
            <section className="border border-line bg-white p-5">
              <div className="mb-4 flex items-start gap-3">
                <ShieldCheck className="mt-1 h-5 w-5 text-mint" />
                <div>
                  <h2 className="text-xl font-extrabold">Local demo mode</h2>
                  <p className="text-sm leading-6 text-ink/70">
                    This is the local development site. Authentication is disabled here so the page stays clean and does not open Telegram.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link href="/dashboard/premium" className="inline-flex h-10 items-center justify-center rounded-md border border-ink px-4 text-sm font-bold">
                  View premium page
                </Link>
              </div>
            </section>
          )}

          {user && (
            <>
              <SubscriptionStatusPanel />
              <PlanSelector />
              <PaymentHistory />
            </>
          )}
        </div>

        <aside className="space-y-6">
          <section className="border border-line bg-white p-5">
            <h2 className="text-lg font-extrabold">Account</h2>
            {loading && <p className="mt-3 text-sm text-ink/70">Loading session...</p>}
            {!loading && user && (
              <div className="mt-3 space-y-2 text-sm">
                <p className="font-bold">{user.firstName ?? "Telegram user"}</p>
                <p className="text-ink/70">@{user.telegramUsername ?? user.telegramId}</p>
              </div>
            )}
            {!loading && !user && <p className="mt-3 text-sm text-ink/70">Not authenticated yet.</p>}
          </section>
          {user && <WalletLinker />}
        </aside>
      </section>
    </main>
  );
}
