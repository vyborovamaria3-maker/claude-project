import KOLLiveTradeFeed from "@/components/trade/KOLLiveTradeFeed";
import KOLTokenFlowPanel from "@/components/trade/KOLTokenFlowPanel";
import KolsTwitterPanel from "@/components/trade/KolsTwitterPanel";

export default function KolsTwitterPage() {
  return (
    <>
      <KOLTokenFlowPanel />
      <KOLLiveTradeFeed />
      <KolsTwitterPanel />
    </>
  );
}
