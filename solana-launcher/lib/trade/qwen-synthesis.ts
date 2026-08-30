import { clamp, type AiEnvelope } from "./social-intelligence";

export type QwenSynthesis = {
  available: boolean;
  headline: string;
  summary: string;
  marketState: string | null;
  socialState: string | null;
  manipulationAssessment: string | null;
  bullCase: string | null;
  bearCase: string | null;
  entryVerdict: string | null;
  priceState: string | null;
  entryAction: string | null;
  whatWouldChange: string[];
  unknowns: string[];
  contradictions: string[];
  reasoning: string[];
  confidence: number;
};

type ExtendedAiResult = NonNullable<AiEnvelope["result"]> & {
  finalIntelligence?: {
    marketState?: string;
    socialState?: string;
    manipulationAssessment?: string;
    bullCase?: string;
    bearCase?: string;
    unknowns?: string[];
    confidence?: number;
  };
  entryAssessment?: {
    priceState?: string;
    entryAction?: string;
    oneLineVerdict?: string;
    whyNow?: string[];
    alreadyPricedIn?: string[];
    missingConfirmation?: string[];
    invalidation?: string[];
    confidence?: number;
  };
  whatWouldChangeConclusion?: string[];
  contradictions?: Array<{ statement?: string; confidence?: number }>;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rows(value: unknown, limit: number) {
  return Array.isArray(value)
    ? value.filter((row): row is string => typeof row === "string" && Boolean(row.trim())).map((row) => row.trim()).slice(0, limit)
    : [];
}

export function buildQwenSynthesis(ai: AiEnvelope | null): QwenSynthesis {
  if (!ai || ai.available === false || !ai.result) {
    return {
      available: false,
      headline: "Qwen-анализ пока недоступен",
      summary: "Детерминированная модель продолжает работать без AI-интерпретации.",
      marketState: null,
      socialState: null,
      manipulationAssessment: null,
      bullCase: null,
      bearCase: null,
      entryVerdict: null,
      priceState: null,
      entryAction: null,
      whatWouldChange: [],
      unknowns: [],
      contradictions: [],
      reasoning: [],
      confidence: 0,
    };
  }

  const result = ai.result as ExtendedAiResult;
  const final = result.finalIntelligence;
  const entry = result.entryAssessment;
  const overall = Number(result.overallConfidence);
  const finalConfidence = Number(final?.confidence);
  const entryConfidence = Number(entry?.confidence);
  const confidenceParts = [overall, finalConfidence, entryConfidence]
    .filter((value) => Number.isFinite(value))
    .map((value) => clamp(value <= 1 ? value * 100 : value));
  const confidence = confidenceParts.length
    ? confidenceParts.reduce((sum, value) => sum + value, 0) / confidenceParts.length
    : 0;

  const entryVerdict = text(entry?.oneLineVerdict);
  const summary = text(result.summary)
    || entryVerdict
    || text(final?.marketState)
    || "Qwen вернул структурированный анализ без общего резюме.";

  const headline = entryVerdict
    ? `Qwen по текущему входу: ${entryVerdict}`
    : text(final?.marketState)
      ? `Qwen по рынку: ${final?.marketState}`
      : "Qwen: независимая интерпретация текущей ситуации";

  return {
    available: true,
    headline,
    summary,
    marketState: text(final?.marketState),
    socialState: text(final?.socialState),
    manipulationAssessment: text(final?.manipulationAssessment),
    bullCase: text(final?.bullCase),
    bearCase: text(final?.bearCase),
    entryVerdict,
    priceState: text(entry?.priceState),
    entryAction: text(entry?.entryAction),
    whatWouldChange: [
      ...rows(result.whatWouldChangeConclusion, 6),
      ...rows(entry?.missingConfirmation, 4),
    ].slice(0, 8),
    unknowns: rows(final?.unknowns, 8),
    contradictions: Array.isArray(result.contradictions)
      ? result.contradictions
          .map((row) => text(row?.statement))
          .filter((row): row is string => Boolean(row))
          .slice(0, 6)
      : [],
    reasoning: rows(result.reasoningSummary, 8),
    confidence,
  };
}
