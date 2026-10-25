import SocialIntelligencePanel from "@/components/trade/SocialIntelligencePanel";

export const dynamic="force-dynamic";

export default function TradeSocialAnalysisPage() {
  return <SocialIntelligencePanel requestOnly={process.env.INTELLIGENCE_AI_ON_DEMAND_ENABLED === "true"} />;
}
