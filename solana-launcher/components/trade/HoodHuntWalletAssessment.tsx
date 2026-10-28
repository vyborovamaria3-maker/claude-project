"use client";

import { useEffect, useState } from "react";
import type { HoodHuntWalletAssessment } from "@/lib/trade/hood-hunt-wallet";

type ApiResponse = { available: true; assessment: HoodHuntWalletAssessment } | { error: string };
const pct = (value: number | null) => value === null ? "—" : (value * 100).toFixed(1) + "%";
const number = (value: number | null, digits = 2) => value === null ? "—" : value.toFixed(digits);

export default function HoodHuntWalletAssessment({ walletAddress }: { walletAddress: string }) {
  const [assessment, setAssessment] = useState<HoodHuntWalletAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setAssessment(null);
    setError(null);
    fetch("/api/trade/hood-hunt/wallet/" + encodeURIComponent(walletAddress), {
      signal: ctrl.signal, cache: "no-store",
    }).then(async (res) => {
      const response = await res.json() as ApiResponse;
      if (!res.ok || !("assessment" in response)) {
        throw new Error("error" in response ? response.error : "Wallet assessment unavailable");
      }
      setAssessment(response.assessment);
    }).catch((reason: unknown) => {
      if (!ctrl.signal.aborted) setError(reason instanceof Error ? reason.message : "No data");
    }).finally(() => {
      if (!ctrl.signal.aborted) setLoading(false);
    });
    return () => ctrl.abort();
  }, [walletAddress]);

  if (loading) return <div className="text-[11px] text-white/40 py-2">Расчёт копируемости кошелька…</div>;
  if (error || !assessment) return (
    <div className="text-[11px] text-white/40 py-2">Профиль Hood Hunt: {error || "нет данных"}</div>
  );

  return (
    <section className="rounded-lg border border-bg-border bg-white/[0.025] p-3 space-y-2" data-tag="trade.hood_hunt_wallet">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-white">Hood Hunt · модель копирования</h3>
        <span className="text-xs font-semibold text-yellow-300">{assessment.status}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-white/70">
        <span>Closed: {assessment.closedTokens}/{assessment.observedTokens}</span>
        <span>PnL: {number(assessment.pnlSol, 3)} SOL</span>
        <span>7д PnL: {number(assessment.pnl7dSol, 3)} SOL</span>
        <span>Win rate: {pct(assessment.winRate)}</span>
        <span>PF: {number(assessment.profitFactor)}</span>
        <span>HOLD median: {assessment.medianHoldSeconds === null ? "—" : number(assessment.medianHoldSeconds / 60, 1) + "m"}</span>
        <span>Flips: {pct(assessment.flipRate)}</span>
        <span>Sniper: {pct(assessment.sniperEntryRate)}</span>
        <span>Own tokens: {pct(assessment.selfCreatedRate)}</span>
        <span>1 buy / 1 sell: {pct(assessment.oneBuyOneSellRate)}</span>
        <span>Copy avg ROI: {assessment.modeledCopy.averageRoiPct === null ? "—" : number(assessment.modeledCopy.averageRoiPct, 1) + "%"}</span>
        <span>Positive copies: {pct(assessment.modeledCopy.profitableRate)} (N={assessment.modeledCopy.samples})</span>
      </div>
      <p className="text-[10px] text-white/45">
        Историческая модель по следующей наблюдаемой сделке. Не гарантирует исполнение в Blizz.
      </p>
      {assessment.reasons.length > 0 && (
        <p className="text-[10px] text-yellow-200/70">{assessment.reasons.join(" ")}</p>
      )}
      <details className="text-[10px] text-white/50">
        <summary className="cursor-pointer">Ограничения данных ({assessment.limitations.length})</summary>
        <ul className="mt-1 list-disc pl-5 space-y-1">
          {assessment.limitations.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      </details>
    </section>
  );
}
