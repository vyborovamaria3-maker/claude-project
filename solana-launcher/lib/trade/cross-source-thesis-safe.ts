import {
  buildCrossSourceThesis as buildBaseCrossSourceThesis,
  type CrossSourceThesis,
} from "./cross-source-thesis";
import {
  buildCrossSourceIntelligence,
  sanitizeCrossSourceArgs,
} from "./cross-source-intelligence-safe";
import type { CrossSourceChronology } from "./cross-source-intelligence";
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

function unique(rows: string[]) {
  return [...new Set(rows.filter((row) => Boolean(row?.trim())).map((row) => row.trim()))];
}

function chronologySequence(chronology: CrossSourceChronology) {
  const ordered = chronology.stages
    .filter((stage) => stage.timestamp != null)
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
  let sequence = ordered.length >= 2
    ? `${ordered.map((stage) => stage.label).join(" → ")}. Chronology coverage ${Math.round(chronology.coverage)}%${chronology.alignmentScore == null ? "" : `; canonical-order alignment ${Math.round(chronology.alignmentScore)}%`}.`
    : "Недостаточно надёжных timestamp-источников для устойчивой cross-source chronology.";

  const lags = [
    ["smart wallet → TG", chronology.walletToTelegramMinutes],
    ["TG → X", chronology.telegramToXMinutes],
    ["X → market", chronology.xToMarketMinutes],
  ] as const;
  const visibleLags = lags
    .filter((row): row is readonly [string, number] => row[1] != null)
    .map(([label, lag]) => `${label}: ${lag >= 0 ? "+" : ""}${Math.round(lag * 10) / 10} мин`);
  if (visibleLags.length) sequence += ` Лаги: ${visibleLags.join(" · ")}.`;
  if (chronology.priceLedSocial) {
    sequence += " Наблюдаемый market impulse появился раньше надёжного X/TG timestamp evidence; social мог частично реагировать на уже начавшееся движение.";
  }
  return sequence;
}

function withoutUnsafeChronologyClaims(rows: string[]) {
  return rows.filter((row) => {
    const value = row.toLowerCase();
    return !value.includes("cross-source chronology")
      && !value.includes("chronology согласована")
      && !value.includes("chronology плохо")
      && !value.includes("market impulse предшествует")
      && !value.includes("price impulse появился раньше")
      && !value.includes("timestamps недостающих chronology")
      && !value.includes("smart wallet → tg → x → market");
  });
}

function chronologyEvidence(chronology: CrossSourceChronology) {
  const agreements: string[] = [];
  const contradictions: string[] = [];
  const nextEvidence: string[] = [];
  if (
    chronology.orderableStages >= 3
    && chronology.alignmentScore != null
    && chronology.alignmentScore >= 67
    && chronology.coverage >= 75
  ) {
    agreements.push(
      `Надёжная chronology согласована примерно на ${Math.round(chronology.alignmentScore)}% при timestamp coverage ${Math.round(chronology.coverage)}%.`,
    );
  }
  if (chronology.priceLedSocial) {
    contradictions.push(
      "Market impulse предшествует надёжному social timestamp evidence; позднюю X/TG активность нельзя считать ранним подтверждением.",
    );
  }
  if (
    chronology.orderableStages >= 3
    && chronology.alignmentScore != null
    && chronology.alignmentScore < 50
  ) {
    contradictions.push(
      "Надёжная chronology плохо совпадает с ранним сценарием smart wallet → TG → X → market.",
    );
  }
  if (chronology.coverage < 75) {
    nextEvidence.push(
      "Нужны надёжные timestamps недостающих chronology-стадий; truncated/top-ranked samples не используются как точное время ускорения.",
    );
  }
  return { agreements, contradictions, nextEvidence };
}

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
  const safeChronologyEvidence = chronologyEvidence(intelligence.chronology);
  const safeSequence = chronologySequence(intelligence.chronology);
  const baseAgreements = withoutUnsafeChronologyClaims(base.agreements);
  const baseContradictions = withoutUnsafeChronologyClaims(base.contradictions);
  const baseNextEvidence = withoutUnsafeChronologyClaims(base.nextEvidence);

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
      sequence: safeSequence,
      independence: intelligence.independence,
      chronology: intelligence.chronology,
      agreements: unique([...baseAgreements, ...safeChronologyEvidence.agreements]),
      contradictions: unique([...baseContradictions, ...safeChronologyEvidence.contradictions]),
      nextEvidence: unique([...baseNextEvidence, ...safeChronologyEvidence.nextEvidence]),
    };
  }

  const independenceText = intelligence.independence.score == null
    ? "независимость пока не измерена"
    : `independence ${Math.round(intelligence.independence.score)}/100, concentration risk ${Math.round(concentrationRisk ?? 0)}/100`;
  const independenceAgreements = baseAgreements.filter((row) => {
    const value = row.toLowerCase();
    return !value.includes("независим") && !value.includes("independence");
  });

  return {
    ...base,
    state,
    confidence: Math.min(base.confidence, state === "risk_dominates" ? 55 : 65),
    headline: state === "risk_dominates"
      ? "Источники совпадают по направлению, но их независимость недостаточна"
      : "Направление источников совпадает, но независимое cross-source подтверждение ещё не доказано",
    currentSituation: `Social и on-chain могут смотреть в одну сторону, но это ещё не подтверждённая независимая структура: ${independenceText}. Совпадение направления не приравнивается к независимости источников.`,
    sequence: safeSequence,
    interpretation: "Несколько положительных сигналов могут быть частью одной волны — связанных каналов, авторов или кошельков. Статус confirmed разрешён только когда deterministic Source Independence действительно strong.",
    entryMeaning: "Не повышать Entry Timing только из-за количества совпадающих сигналов. Нужен новый независимый слой подтверждения либо снижение concentration risk.",
    independence: intelligence.independence,
    chronology: intelligence.chronology,
    agreements: unique([...independenceAgreements, ...safeChronologyEvidence.agreements]),
    contradictions: unique([
      ...baseContradictions,
      ...safeChronologyEvidence.contradictions,
      `Cross-source direction совпадает, но независимость не strong (${independenceText}).`,
    ]),
    nextEvidence: unique([...baseNextEvidence, ...safeChronologyEvidence.nextEvidence]),
  };
}
