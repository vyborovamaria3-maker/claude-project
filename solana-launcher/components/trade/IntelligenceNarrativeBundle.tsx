"use client";

import { useMemo, type ReactNode } from "react";
import { Send, Twitter, WalletCards } from "lucide-react";
import CrossSourceThesisCard from "@/components/trade/CrossSourceThesisCard";
import EntryThesisCard from "@/components/trade/EntryThesisCard";
import QwenSynthesisCard from "@/components/trade/QwenSynthesisCard";
import SourceNarrativeCard from "@/components/trade/SourceNarrativeCard";
import { buildCrossSourceThesis } from "@/lib/trade/cross-source-thesis";
import { buildEntryThesis } from "@/lib/trade/entry-thesis";
import { buildQwenSynthesis } from "@/lib/trade/qwen-synthesis";
import { buildSourceNarrativeSynthesis } from "@/lib/trade/source-narrative-synthesis";
import type { LiveIntelligenceModel } from "@/lib/trade/live-intelligence";
import type {
  AiEnvelope,
  ChainAnalysis,
  Channel,
  DerivedSocial,
  Market,
  SocialTimeline,
  TwitterStats,
} from "@/lib/trade/social-intelligence";

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

export default function IntelligenceNarrativeBundle({
  x,
  telegram,
  chain,
  market,
  channels,
  derived,
  ai,
  model,
  xDetails,
  telegramDetails,
  chainDetails,
}: Props) {
  const narratives = useMemo(
    () => buildSourceNarrativeSynthesis({
      x,
      tg: telegram,
      chain,
      channels,
      derived,
      ai,
    }),
    [x, telegram, chain, channels, derived, ai],
  );

  const entryThesis = useMemo(
    () => buildEntryThesis({
      market,
      chain,
      derived,
      ai,
      model,
      narratives,
    }),
    [market, chain, derived, ai, model, narratives],
  );

  const crossSourceThesis = useMemo(
    () => buildCrossSourceThesis({
      x,
      telegram,
      chain,
      market,
      derived,
      ai,
      narratives,
      entry: entryThesis,
    }),
    [x, telegram, chain, market, derived, ai, narratives, entryThesis],
  );

  const qwenSynthesis = useMemo(() => buildQwenSynthesis(ai), [ai]);

  return (
    <section className="space-y-3" data-tag="trade.intelligence_narrative_bundle.v1">
      <EntryThesisCard thesis={entryThesis} />
      <QwenSynthesisCard synthesis={qwenSynthesis} />
      <CrossSourceThesisCard thesis={crossSourceThesis} />

      <SourceNarrativeCard
        title="X / Twitter"
        icon={<Twitter />}
        narrative={narratives.x}
        collapseKey="twitter"
      >
        {xDetails}
      </SourceNarrativeCard>

      <SourceNarrativeCard
        title="Telegram"
        icon={<Send />}
        narrative={narratives.telegram}
        collapseKey="telegram"
      >
        {telegramDetails}
      </SourceNarrativeCard>

      <SourceNarrativeCard
        title="Blockchain"
        icon={<WalletCards />}
        narrative={narratives.chain}
        collapseKey="blockchain"
      >
        {chainDetails}
      </SourceNarrativeCard>
    </section>
  );
}
