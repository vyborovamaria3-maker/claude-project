import {
  buildCrossSourceThesis as buildBaseCrossSourceThesis,
  type CrossSourceThesis,
} from "./cross-source-thesis";
import {
  buildCrossSourceIntelligence,
  sanitizeCrossSourceArgs,
} from "./cross-source-intelligence-safe";
import type { EntryThesis } from "./entry-thesis";
import type { SourceNarratives } from "./source-narrative";
import type {
  AiEnvelope,
  ChainAnalysis,
  DerivedSocial,
  Market,
  SocialTimeline,
  TwitterStats,
} from "./social-intelligence";

type Args = {
  x: TwitterStats | null;
  telegram: SocialTimeline | null;
  chain: ChainAnalysis | null;
  market: Market | null;
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  narratives: SourceNarratives;
  entry: EntryThesis;
};

export function buildCrossSourceThesis(args: Args): CrossSourceThesis {
  const safeCore = sanitizeCrossSourceArgs({
    x: args.x,
    telegram: args.telegram,
    chain: args.chain,
    market: args.market,
    derived: args.derived,
  });
  const intelligence = buildCrossSourceIntelligence(safeCore);
  const base = buildBaseCrossSourceThesis({
    ...args,
    ...safeCore,
  });

  const independenceStrong = intelligence.independence.verdict === "strong";
  const concentrationRisk = intelligence.independence.concentrationRisk;
  const falseConfirmed = base.state === "confirmed" && !independenceStrong;
  const state: CrossSourceThesis["state"] = falseConfirmed
    ? (intelligence.independence.verdict === "concentrated" || (concentrationRisk ?? 0) >= 65
      ? "risk_dominates"
      : "divergence")
    : base.state;

  if (!falseConfirmed) {
    return {
      ...base,
      independence: intelligence.independence,
      chronology: intelligence.chronology,
    };
  }

  const independenceText = intelligence.independence.score == null
    ? "независимость пока не измерена"
    : `independence ${Math.round(intelligence.independence.score)}/100, concentration risk ${Math.round(concentrationRisk ?? 0)}/100`;

  return {
    ...base,
    state,
    headline: state === "risk_dominates"
      ? "Источники совпадают по направлению, но их независимость недостаточна"
      : "Направление источников совпадает, но независимое cross-source подтверждение ещё не доказано",
    currentSituation: `Social и on-chain могут смотреть в одну сторону, но это ещё не подтверждённая независимая структура: ${independenceText}. Совпадение направления не приравнивается к независимости источников.`,
    interpretation: "Несколько положительных сигналов могут быть частью одной волны — связанных каналов, авторов или кошельков. Статус confirmed разрешён только когда deterministic Source Independence действительно strong.",
    entryMeaning: "Не повышать Entry Timing только из-за количества совпадающих сигналов. Нужен новый независимый слой подтверждения либо снижение concentration risk.",
    independence: intelligence.independence,
    chronology: intelligence.chronology,
    contradictions: [
      ...base.contradictions,
      `Cross-source direction совпадает, но независимость не strong (${independenceText}).`,
    ],
  };
}
