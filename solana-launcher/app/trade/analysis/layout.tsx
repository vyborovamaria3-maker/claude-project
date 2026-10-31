// Shared layout for unified analysis and backwards-compatible detailed routes.
// Navigation now lives inside the overview modal; legacy deep links remain available.
export default function TradeAnalysisLayout({ children }: { children: React.ReactNode }) {
  return <div className="space-y-5" data-tag="trade.analysis.layout">{children}</div>;
}
