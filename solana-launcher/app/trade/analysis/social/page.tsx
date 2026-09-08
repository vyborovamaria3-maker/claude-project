"use client";

import { useSearchParams } from "next/navigation";
import PumpFunChart from "@/components/PumpFunChart";
import SocialIntelligencePanel from "@/components/trade/SocialIntelligencePanel";

export default function TradeSocialAnalysisPage() {
  const params = useSearchParams();
  const mint = params.get("mint")?.trim() || "";

  return (
    <div className="space-y-5">
      {mint ? (
        <section className="surface-panel overflow-hidden rounded-2xl border border-bg-border">
          <div className="border-b border-bg-border px-4 py-3">
            <h2 className="text-sm font-semibold text-content">График монеты</h2>
            <p className="mt-1 font-mono text-[10px] text-content-faint">
              {mint.slice(0, 8)}…{mint.slice(-7)}
            </p>
          </div>
          <PumpFunChart mint={mint} />
        </section>
      ) : null}

      <SocialIntelligencePanel />
    </div>
  );
}
