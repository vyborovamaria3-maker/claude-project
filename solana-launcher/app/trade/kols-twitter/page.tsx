import KOLBacktestPanel from "@/components/trade/KOLBacktestPanel";
import KOLLiveTradeFeed from "@/components/trade/KOLLiveTradeFeed";
import KOLTokenFlowPanel from "@/components/trade/KOLTokenFlowPanel";
import KolsTwitterPanel from "@/components/trade/KolsTwitterPanel";

export default function KolsTwitterPage() {
  return (
    <div className="min-w-0">
      <KolsTwitterPanel />
      <KOLTokenFlowPanel />
      <KOLLiveTradeFeed />
      <KOLBacktestPanel />
    </div>
  );
}
