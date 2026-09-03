import { buildLiveIntelligence, type LiveIntelligenceModel } from "./live-intelligence";
import {
  clamp,
  type AiEnvelope,
  type ChainAnalysis,
  type Channel,
  type DerivedSocial,
  type Market,
  type SocialTimeline,
  type TwitterStats,
} from "./social-intelligence";
import {
  hasChainIntelligence,
  hasEarlyTimingEvidence,
  hasFreshMarket,
  hasTelegramIntelligence,
  hasXIntelligence,
} from "./intelligence-coverage";

type BuildArgs = {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  market: Market | null;
  chain: ChainAnalysis | null;
  channels: Channel[];
  derived: DerivedSocial;
  ai: AiEnvelope | null;
  featureCoverage?: number | null;
  liveImpact?: number;
};

function weighted(parts: Array<{ value: number | null; weight: number }>) {
  const available = parts.filter((part): part is { value: number; weight: number } => part.value != null);
  const total = available.reduce((sum, part) => sum + part.weight, 0);
  if (!total) return 0;
  return clamp(available.reduce((sum, part) => sum + clamp(part.value) * part.weight, 0) / total);
}

function entryStatus(score: number) {
  if (score >= 78) return "Сильный вход";
  if (score >= 64) return "Можно рассматривать";
  if (score >= 50) return "Ждать подтверждения";
  if (score >= 35) return "Поздний / слабый вход";
  return "Избегать входа";
}

function verdict(model: LiveIntelligenceModel, score: number) {
  if (model.riskScore >= 72) {
    return "Высокий риск — позитивные сигналы не компенсируют качество структуры";
  }
  if (model.tokenStrength >= 70 && score < 55) {
    return "Монета выглядит сильнее среднего, но текущий вход уже хуже самой структуры";
  }
  if (model.tokenStrength >= 70 && score >= 64) {
    return "Структура сильная, а момент входа пока подтверждается несколькими источниками";
  }
  if (model.tokenStrength >= 55) {
    return "Структура смешанная: нужен дополнительный триггер перед входом";
  }
  return "Структура слабая — подтверждений недостаточно";
}

export function buildCoverageAwareLiveIntelligence(args: BuildArgs): LiveIntelligenceModel {
  const xAvailable = hasXIntelligence(args.x);
  const tgAvailable = hasTelegramIntelligence(args.tg);
  const chainAvailable = hasChainIntelligence(args.chain);
  const marketFresh = hasFreshMarket(args.market);
  const earlyKnown = hasEarlyTimingEvidence(
    xAvailable ? args.x : null,
    tgAvailable ? args.tg : null,
    args.market,
  );

  const model = buildLiveIntelligence({
    ...args,
    x: xAvailable ? args.x : null,
    tg: tgAvailable ? args.tg : null,
    chain: chainAvailable ? args.chain : null,
    market: marketFresh ? args.market : null,
  });

  const hasSocial = xAvailable || tgAvailable;
  const hasRiskEvidence = hasSocial || chainAvailable || marketFresh;
  const entryBase = weighted([
    { value: model.tokenStrength, weight: 0.44 },
    { value: hasSocial && earlyKnown ? args.derived.early : null, weight: 0.14 },
    { value: hasSocial ? args.derived.organic : null, weight: 0.10 },
    { value: chainAvailable ? model.chain.score : null, weight: 0.12 },
    { value: hasRiskEvidence ? 100 - model.riskScore : null, weight: 0.20 },
  ]);
  const whaleSellerCount = chainAvailable
    ? model.chain.actors.filter((actor) => actor.role === "whale" && actor.direction === "selling").length
    : 0;
  const sellerPenalty = chainAvailable
    ? whaleSellerCount * 4 + Math.max(0, model.chain.smartSellers - model.chain.smartBuyers) * 5
    : 0;
  const liveImpact = clamp(Number(args.liveImpact) || 0, -10, 10);
  let score = clamp(
    entryBase
      - (marketFresh ? model.market.overextension * 0.34 : 0)
      - sellerPenalty
      + liveImpact * 0.55,
  );

  if (!marketFresh && score > 60) score = 60;

  const status = entryStatus(score);
  const currentVerdict = verdict(model, score);
  const staleMarket = Boolean(args.market?.pair && args.market.meta?.stale === true);
  const confidence = clamp(model.confidence - (staleMarket ? 4 : 0));
  const market = staleMarket
    ? {
        ...model.market,
        state: "рыночный снимок устарел и исключён из оценки текущей цены",
        summary: "Market snapshot помечен stale. Его 1ч/24ч движение, ликвидность и перегрев не используются как доказательство того, что вход сейчас дорогой, дешёвый или нестабильный.",
        facts: [
          "stale market: исключён из current-entry scoring",
          "нужен свежий market refresh для оценки текущей цены",
        ],
      }
    : model.market;

  return {
    ...model,
    entryScore: score,
    entryStatus: status,
    verdict: currentVerdict,
    summary: `${currentVerdict}. Сила монеты ${Math.round(model.tokenStrength)}/100, качество входа ${Math.round(score)}/100, риск ${Math.round(model.riskScore)}/100, уверенность ${Math.round(confidence)}%.`,
    confidence,
    market,
  };
}
