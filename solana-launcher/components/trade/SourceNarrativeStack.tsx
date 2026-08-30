"use client";

import { useMemo, type ReactNode } from "react";
import { Send, Twitter, WalletCards } from "lucide-react";
import SourceNarrativeCard from "@/components/trade/SourceNarrativeCard";
import { buildSourceNarratives } from "@/lib/trade/source-narrative";
import type {
  AiEnvelope,
  ChainAnalysis,
  Channel,
  DerivedSocial,
  SocialTimeline,
  TwitterStats,
} from "@/lib/trade/social-intelligence";

type Props = {
  x: TwitterStats | null;
  telegram: SocialTimeline | null;
  chain: ChainAnalysis | null;
  channels: Channel[];
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  xDetails?: ReactNode;
  telegramDetails?: ReactNode;
  chainDetails?: ReactNode;
};

export default function SourceNarrativeStack({
  x,
  telegram,
  chain,
  channels,
  derived,
  ai,
  xDetails,
  telegramDetails,
  chainDetails,
}: Props) {
  const narratives = useMemo(
    () => buildSourceNarratives({
      x,
      tg: telegram,
      chain,
      channels,
      derived,
      ai,
    }),
    [x, telegram, chain, channels, derived, ai],
  );

  return (
    <section className="space-y-3" data-tag="trade.source_narratives.v1">
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
