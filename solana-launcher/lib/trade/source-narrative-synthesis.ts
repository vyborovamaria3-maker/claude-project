import { clamp, type AiEnvelope, type ChainAnalysis, type Channel, type DerivedSocial, type SocialTimeline, type TwitterStats } from "./social-intelligence";
import {
  buildSourceNarratives,
  type SourceNarrative,
  type SourceNarratives,
} from "./source-narrative";

type Args = {
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  chain: ChainAnalysis | null;
  channels: Channel[];
  derived: DerivedSocial;
  ai: AiEnvelope | null;
};

type AiSourceAssessment = {
  currentSituation?: string;
  interpretation?: string;
  entryImpact?: string;
  supportingFeatureKeys?: string[];
  confidence?: number;
};

type ExtendedResult = NonNullable<AiEnvelope["result"]> & {
  sourceAssessments?: {
    x?: AiSourceAssessment;
    telegram?: AiSourceAssessment;
    chain?: AiSourceAssessment;
  };
};

function clean(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function qwenAssessment(
  ai: AiEnvelope | null,
  source: keyof NonNullable<ExtendedResult["sourceAssessments"]>,
): AiSourceAssessment | null {
  if (!ai || ai.available === false || !ai.result) return null;
  const result = ai.result as ExtendedResult;
  const assessment = result.sourceAssessments?.[source];
  if (!assessment) return null;
  const confidence = Number(assessment.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.45) return null;
  return assessment;
}

function appendQwen(base: string, qwen: string | null) {
  if (!qwen) return base;
  const normalizedBase = base.toLowerCase().replace(/\s+/g, " ");
  const normalizedQwen = qwen.toLowerCase().replace(/\s+/g, " ");
  if (normalizedBase.includes(normalizedQwen) || normalizedQwen.includes(normalizedBase)) return base;
  return `${base} Qwen: ${qwen}`;
}

function mergeOne(
  base: SourceNarrative,
  assessment: AiSourceAssessment | null,
): SourceNarrative {
  if (!assessment) return base;
  const aiConfidenceRaw = Number(assessment.confidence);
  const aiConfidence = clamp(aiConfidenceRaw <= 1 ? aiConfidenceRaw * 100 : aiConfidenceRaw);
  const keys = Array.isArray(assessment.supportingFeatureKeys)
    ? assessment.supportingFeatureKeys.filter((key): key is string => typeof key === "string" && Boolean(key.trim())).slice(0, 8)
    : [];

  return {
    ...base,
    currentSituation: appendQwen(base.currentSituation, clean(assessment.currentSituation)),
    interpretation: appendQwen(base.interpretation, clean(assessment.interpretation)),
    entryMeaning: appendQwen(base.entryMeaning, clean(assessment.entryImpact)),
    parameters: [
      ...base.parameters,
      {
        label: "Qwen confidence",
        value: `${Math.round(aiConfidence)}%`,
        note: keys.length ? `опирается на: ${keys.join(", ")}` : "AI-интерпретация; факты остаются детерминированными",
      },
    ],
    confidence: clamp(base.confidence * 0.75 + aiConfidence * 0.25),
  };
}

export function buildSourceNarrativeSynthesis(args: Args): SourceNarratives {
  const deterministic = buildSourceNarratives(args);
  return {
    x: mergeOne(deterministic.x, qwenAssessment(args.ai, "x")),
    telegram: mergeOne(deterministic.telegram, qwenAssessment(args.ai, "telegram")),
    chain: mergeOne(deterministic.chain, qwenAssessment(args.ai, "chain")),
  };
}
