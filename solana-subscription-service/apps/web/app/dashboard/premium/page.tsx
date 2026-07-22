"use client";

import Link from "next/link";
import { ArrowLeft, Lock, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";

interface AnalyticsResponse {
  wallet: string | null;
  balanceSol: number;
  transactions: { signature: string; type: string; amountSol: number; timestamp: string }[];
  riskFlags: string[];
}

export default function PremiumPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<AnalyticsResponse>("/api/premium/wallet-analytics")
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Premium access required"));
  }, []);

  return (
    <main className="min-h-screen bg-panel">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm font-bold text-ocean">
          <ArrowLeft className="h-4 w-4" />
          Dashboard
        </Link>
        <div className="mt-6 flex items-center gap-3">
          <WalletCards className="h-7 w-7 text-mint" />
          <h1 className="text-3xl font-black">Premium wallet analytics</h1>
        </div>

        {error && (
          <section className="mt-6 border border-coral bg-white p-5">
            <div className="flex items-center gap-3">
              <Lock className="h-5 w-5 text-coral" />
              <p className="font-bold">{error}</p>
            </div>
          </section>
        )}

        {data && (
          <section className="mt-6 grid gap-5 md:grid-cols-[280px_minmax(0,1fr)]">
            <div className="border border-line bg-white p-5">
              <p className="text-sm font-bold text-ink/60">Wallet</p>
              <p className="mt-2 break-all text-sm">{data.wallet ?? "No wallet linked"}</p>
              <p className="mt-6 text-sm font-bold text-ink/60">Balance</p>
              <p className="mt-2 text-3xl font-black">{data.balanceSol} SOL</p>
            </div>
            <div className="border border-line bg-white p-5">
              <h2 className="text-lg font-extrabold">Recent activity</h2>
              <div className="mt-4 divide-y divide-line">
                {data.transactions.map((tx) => (
                  <div key={tx.signature} className="grid gap-2 py-3 text-sm sm:grid-cols-[1fr_120px_120px]">
                    <span className="font-mono">{tx.signature}</span>
                    <span className="font-bold capitalize">{tx.type}</span>
                    <span>{tx.amountSol} SOL</span>
                  </div>
                ))}
              </div>
              <h2 className="mt-6 text-lg font-extrabold">Signals</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {data.riskFlags.map((flag) => (
                  <span key={flag} className="rounded-md bg-mint/15 px-3 py-2 text-sm font-bold text-ocean">
                    {flag}
                  </span>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
