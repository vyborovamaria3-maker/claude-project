"use client";

import { useMemo, type ReactNode } from "react";
import { Send, Twitter, WalletCards } from "lucide-react";
import CollapsePersistence from "@/components/trade/CollapsePersistence";
import CrossSourceThesisCard from "@/components/trade/CrossSourceThesisCard";
import EntryThesisCard from "@/components/trade/EntryThesisCard";
import QwenSynthesisCard from "@/components/trade/QwenSynthesisCard";
import SourceNarrativeCard from "@/components/trade/SourceNarrativeCard";
import { buildCrossSourceThesis } from "@/lib/trade/cross-source-thesis";
import { buildCoverageAwareEntryThesis } from "@/lib/trade/entry-thesis-safe";
import { hasChainIntelligence, hasFreshMarket, hasTelegramIntelligence, hasXIntelligence } from "@/lib/trade/intelligence-coverage";
import { buildQwenSynthesis } from "@/lib/trade/qwen-synthesis";
import { buildSourceNarrativeSynthesis } from "@/lib/trade/source-narrative-synthesis";
import type { LiveIntelligenceModel } from "@/lib/trade/live-intelligence";
import type { AiEnvelope, ChainAnalysis, Channel, DerivedSocial, Market, SocialTimeline, TwitterStats } from "@/lib/trade/social-intelligence";

type Props = {
  x: TwitterStats | null;
  telegram: SocialTimeline | null;
  chain: ChainAnalysis | null;
  market: Market | null;
  channels: Channel[];
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  model: LiveIntelligenceModel;
  xDetails?: ReactNode;
  telegramDetails?: ReactNode;
  chainDetails?: ReactNode;
};

export default function IntelligenceNarrativeBundle({ x, telegram, chain, market, channels, derived, ai, model, xDetails, telegramDetails, chainDetails }: Props) {
  const xAvailable = hasXIntelligence(x);
  const telegramAvailable = hasTelegramIntelligence(telegram);
  const chainAvailable = hasChainIntelligence(chain);
  const marketFresh = hasFreshMarket(market);

  const narratives = useMemo(
    () => buildSourceNarrativeSynthesis({ x, tg: telegram, chain, channels, derived, ai }),
    [x, telegram, chain, channels, derived, ai],
  );
  const entryThesis = useMemo(
    () => buildCoverageAwareEntryThesis({ x, telegram, market, chain, derived, ai, model, narratives }),
    [x, telegram, market, chain, derived, ai, model, narratives],
  );
  const crossSourceThesis = useMemo(
    () => buildCrossSourceThesis({
      x: xAvailable ? x : null,
      telegram: telegramAvailable ? telegram : null,
      chain: chainAvailable ? chain : null,
      market: marketFresh ? market : null,
      derived,
      ai,
      narratives,
      entry: entryThesis,
    }),
    [x, telegram, chain, market, derived, ai, narratives, entryThesis, xAvailable, telegramAvailable, chainAvailable, marketFresh],
  );
  const qwenSynthesis = useMemo(() => buildQwenSynthesis(ai), [ai]);

  return (
    <section className="space-y-3" data-tag="trade.intelligence_narrative_bundle.v2">
      <CollapsePersistence />
      <EntryThesisCard thesis={entryThesis} />
      <QwenSynthesisCard synthesis={qwenSynthesis} />
      <CrossSourceThesisCard thesis={crossSourceThesis} />
      <SourceNarrativeCard title="X / Twitter" icon={<Twitter />} narrative={narratives.x} collapseKey="twitter">{xDetails}</SourceNarrativeCard>
      <SourceNarrativeCard title="Telegram" icon={<Send />} narrative={narratives.telegram} collapseKey="telegram">{telegramDetails}</SourceNarrativeCard>
      <SourceNarrativeCard title="Blockchain" icon={<WalletCards />} narrative={narratives.chain} collapseKey="blockchain">{chainDetails}</SourceNarrativeCard>
    </section>
  );
}
