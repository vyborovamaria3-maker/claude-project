import UnifiedAnalysisClient from "@/components/trade/UnifiedAnalysisClient";

export const dynamic = "force-dynamic";

// Keep the original server-only on-demand AI policy for every embedded source.
// Data APIs and collectors remain unchanged.
export default function TradeAnalysisPage() {
  return (
    <UnifiedAnalysisClient requestOnly={process.env.INTELLIGENCE_AI_ON_DEMAND_ENABLED === "true"} />
  );
}
