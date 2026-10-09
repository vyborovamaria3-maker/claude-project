export type GuardSnapshot = {
  headline?: { contradictions?: number | null };
  dataQuality?: {
    chainTruncated?: boolean;
    evidence?: Record<string, { available?: boolean; complete?: boolean; coveragePct?: number | null; ageMs?: number | null; futureByMs?: number | null }>;
    sourceTimes?: { sourceSkewMs?: number | null };
  };
  unknowns?: string[];
  compactMeta?: { payloadTruncated?: boolean };
  reportContract?: { requiredSections?: string[] };
};

export type GuardableAiReport = {
  summary?: string | null;
  overallConfidence?: number | null;
  reasoningSummary?: string[];
  finalIntelligence?: {
    marketState?: string | null;
    socialState?: string | null;
    manipulationAssessment?: string | null;
    bullCase?: string | null;
    bearCase?: string | null;
    unknowns?: string[];
    confidence?: number | null;
  };
  risks?: Array<{
    severity?: string | null;
    label?: string | null;
    type?: string | null;
    explanation?: string | null;
    rationale?: string | null;
  }>;
  contradictions?: Array<{ statement?: string | null; confidence?: number | null }>;
  whatWouldChangeConclusion?: string[];
  sectionReports?: Record<string, string | null>;
};

export type AiReportGuardViolationCode =
  | "funding_ownership_overclaim"
  | "coordination_insider_overclaim"
  | "funding_insider_overclaim"
  | "coordination_ownership_overclaim"
  | "jito_bundle_overclaim"
  | "correlation_causality_overclaim"
  | "observational_causality_overclaim"
  | "confidence_probability_overclaim"
  | "deterministic_future_prediction"
  | "unknown_promoted_to_safe"
  | "confidence_exceeds_evidence_cap"
  | "contradictions_omitted"
  | "unknowns_omitted"
  | "transport_compaction_not_disclosed"
  | "required_sections_missing"
  | "unsupported_social_claim"
  | "prompt_injection_artifact";

export type AiReportGuardViolation = {
  code: AiReportGuardViolationCode;
  severity: "medium" | "high" | "critical";
  message: string;
  excerpt?: string;
};

export type AiReportGuardResult = {
  status: "pass" | "warn" | "reject";
  evidenceQuality01: number;
  confidenceCap01: number;
  reportedConfidence01: number | null;
  effectiveConfidence01: number | null;
  violations: AiReportGuardViolation[];
  checks: {
    evidenceRows: number;
    completeEvidenceRows: number;
    partialEvidenceRows: number;
    unavailableEvidenceRows: number;
    requiredSectionsPresent: number;
    requiredSectionsTotal: number;
  };
};

const OWNERSHIP_TERMS = /(?:same\s+(?:owner|entity|controller)|common\s+ownership|controlled\s+by\s+the\s+same|owned\s+by\s+the\s+same|общ(?:ий|его)\s+(?:владелец|контрол)|одн(?:ому|им)\s+(?:владельц|контрол)|принадлежат\s+одн|контролируются\s+одн)/iu;
const INSIDER_TERMS = /(?:insider(?:s|\s+wallets?)?|инсайдер(?:ы|ские|ский|ов)?|внутренн(?:ий|ие)\s+кошельк)/iu;
const FUNDING_TERMS = /(?:funding|funded|funder|финансир|фандинг|источник\s+средств)/iu;
const COORDINATION_TERMS = /(?:coordination|coordinated|coactivity|координац|синхронн(?:ые|ая|о)\s+(?:действ|торг|продаж|покуп))/iu;
const JITO_TERMS = /(?:jito|tip|чаев(?:ые|ых)|тип\s+jito)/iu;
const VERIFIED_BUNDLE_TERMS = /(?:verified\s+(?:atomic\s+)?bundle|atomic\s+bundle|подтвержд[её]нн(?:ый|ая)\s+(?:атомарн(?:ый|ая)\s+)?бандл|верифицированн(?:ый|ая)\s+бандл)/iu;
const CORRELATION_TERMS = /(?:correlation|spearman|pearson|rho|backtest|корреляц|спирмен|пирсон|бэктест)/iu;
const OBSERVATIONAL_SIGNAL_TERMS = /(?:OFI|order\s+flow|buy[-\s]?flow|sell[-\s]?flow|whale(?:s|\s+flow)?|smart\s+money|holder\s+growth|bundle|wash|поток\s+(?:покупок|продаж)|киты|смарт[-\s]?мани|рост\s+холдер)/iu;
const CONFIDENCE_TERMS = /(?:confidence|score|уверенност|скор)/iu;
const PROBABILITY_TERMS = /(?:chance|probability|odds|вероятност|шанс)/iu;
const CAUSAL_TERMS = /(?:caused|causes|caused\s+by|led\s+to|drives?|because\s+of(?:\s+this)?|due\s+to|as\s+a\s+result\s+of|причин(?:а|ой)|вызвал[аои]?|прив[её]л[аои]?\s+к|обусловил[аои]?|из-за(?:\s+этого)?|вследствие|благодаря)/iu;
const ABSOLUTE_FUTURE_TERMS = /(?:will\s+(?:definitely|certainly)?\s*(?:rise|fall|pump|dump|grow|crash)|guarantee(?:s|d)?|certain\s+to|definitely\s+(?:will|going\s+to)|точно\s+(?:вырастет|упад[её]т|памп|дамп)|обязательно\s+(?:вырастет|упад[её]т|будет)|гарантированно|безусловно\s+(?:вырастет|упад[её]т))/iu;
const SAFE_TERMS = /(?:risk[-\s]?free|completely\s+safe|no\s+(?:material\s+)?risk|безопас(?:ен|на|но|ный)|рисков\s+нет|без\s+риска)/iu;
const TRUNCATION_DISCLOSURE = /(?:truncat|compact|сокращ|усеч|часть\s+детал|payload)/iu;
const SOCIAL_CLAIM_TERMS = /(?:telegram|twitter|x\s*\/\s*twitter|social\s+(?:sentiment|mentions|state)|соц(?:иальн)?|телеграм|твиттер)/iu;
const SOCIAL_UNKNOWN_TERMS = /(?:unknown|unavailable|not\s+provided|no\s+data|missing|неизвест|недоступ|нет\s+данных|отсутств)/iu;
const PROMPT_INJECTION_SAFE_CONTEXT = /(?:untrusted|ignored\s+as\s+data|prompt[-\s]?injection\s+(?:attempt|text)|did\s+not\s+follow|не\s+выполн|игнорирован|недоверенн)/iu;
const PROMPT_INJECTION_ARTIFACT = /(?:ignore\s+(?:all\s+)?previous\s+instructions|reveal\s+(?:the\s+)?system\s+prompt|developer\s+message|disable\s+(?:the\s+)?guard|send\s+(?:api\s+keys?|secrets?)|игнорируй\s+(?:все\s+)?предыдущие\s+инструкции|покажи\s+системн(?:ый|ые)\s+промпт|отключи\s+guard|выведи\s+(?:api[-\s]?ключ|секрет))/iu;
const HEDGE_OR_NEGATION = /(?:not\s+(?:proof|prove|confirmed|causal|caused|because)|no\s+(?:proof|evidence)|not\s+(?:a\s+)?probability|not\s+necessarily|does\s+not\s+guarantee|not\s+guarantee|cannot\s+guarantee|cannot\s+rule\s+out|cannot\s+(?:prove|establish)|does\s+not\s+(?:prove|establish)|may|might|could|possible|possibly|suggests?|insufficient|uncertain|не\s+(?:доказывает|подтверждает|означает|является\s+причин|причин)|недостаточ|возможн|может|предполож|неопредел|нет\s+доказ|не\s+является\s+вероятност|не\s+обязательно|не\s+гарантирует|не\s+безопас|нельзя\s+(?:сказать|утверждать)|cannot\s+(?:say|claim))/iu;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeConfidence(value: unknown): number | null {
  if (!finite(value) || value < 0) return null;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return null;
}

function sentenceSegments(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((row) => row.trim())
    .filter(Boolean);
}

function contrastClauses(sentence: string): string[] {
  const rows = sentence
    .split(/\s+(?:but|however|nevertheless|yet|although|но|однако|тем\s+не\s+менее|при\s+этом)\s+|;+/iu)
    .map((row) => row.trim())
    .filter(Boolean);
  return rows.length ? rows : [sentence];
}

function reportTexts(report: GuardableAiReport): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  };
  push(report.summary);
  for (const row of report.reasoningSummary || []) push(row);
  push(report.finalIntelligence?.marketState);
  push(report.finalIntelligence?.socialState);
  push(report.finalIntelligence?.manipulationAssessment);
  push(report.finalIntelligence?.bullCase);
  push(report.finalIntelligence?.bearCase);
  for (const row of report.finalIntelligence?.unknowns || []) push(row);
  for (const row of report.risks || []) {
    push(row.label);
    push(row.type);
    push(row.explanation);
    push(row.rationale);
  }
  for (const row of report.contradictions || []) push(row.statement);
  for (const row of report.whatWouldChangeConclusion || []) push(row);
  for (const row of Object.values(report.sectionReports || {})) push(row);
  return out;
}

function allSentences(report: GuardableAiReport): string[] {
  return reportTexts(report).flatMap(sentenceSegments);
}

function unhedged(sentence: string): boolean {
  return !HEDGE_OR_NEGATION.test(sentence);
}

function evidenceQuality(snapshot: GuardSnapshot) {
  const rows = Object.values(snapshot.dataQuality?.evidence || {});
  let complete = 0;
  let partial = 0;
  let unavailable = 0;
  const scores: number[] = [];
  for (const row of rows) {
    if (row.available !== true || (finite(row.futureByMs) && row.futureByMs > 30_000)) {
      unavailable += 1;
      scores.push(0);
      continue;
    }
    if (row.complete === true) {
      complete += 1;
      const completeCoverage = finite(row.coveragePct) ? clamp01(row.coveragePct / 100) : 1;
      scores.push(completeCoverage);
      continue;
    }
    partial += 1;
    const coverage = finite(row.coveragePct) ? clamp01(row.coveragePct / 100) : 0.5;
    scores.push(coverage);
  }
  const quality = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0.5;
  return { quality: clamp01(quality), rows: rows.length, complete, partial, unavailable };
}

function confidenceCap(snapshot: GuardSnapshot, quality: number): number {
  let cap = quality < 0.4 ? 0.55 : quality < 0.65 ? 0.7 : quality < 0.85 ? 0.85 : 0.95;
  if (snapshot.dataQuality?.chainTruncated) cap = Math.min(cap, 0.7);
  if (snapshot.compactMeta?.payloadTruncated) cap = Math.min(cap, 0.7);
  const skew = snapshot.dataQuality?.sourceTimes?.sourceSkewMs;
  if (finite(skew) && skew > 15 * 60_000) cap = Math.min(cap, 0.65);
  else if (finite(skew) && skew > 5 * 60_000) cap = Math.min(cap, 0.75);
  return clamp01(cap);
}

function excerpt(sentence: string): string {
  return sentence.length <= 280 ? sentence : `${sentence.slice(0, 277)}…`;
}

function pushUnique(violations: AiReportGuardViolation[], violation: AiReportGuardViolation) {
  if (!violations.some((row) => row.code === violation.code && row.excerpt === violation.excerpt)) violations.push(violation);
}


/**
 * Evaluate one free-form AI statement with the same semantic overclaim rules used by
 * the full report guard. This primitive is reused by the claim-level validator so
 * structured claims and prose cannot drift into two different policy implementations.
 */
export function evaluateBlockchainAiTextOverclaims(text: string): AiReportGuardViolation[] {
  const violations: AiReportGuardViolation[] = [];
  const sentences = sentenceSegments(text);
  for (const sentence of sentences) {
    const fundingContext = FUNDING_TERMS.test(sentence);
    const coordinationContext = COORDINATION_TERMS.test(sentence);
    const jitoContext = JITO_TERMS.test(sentence);
    const correlationContext = CORRELATION_TERMS.test(sentence);
    const observationalContext = OBSERVATIONAL_SIGNAL_TERMS.test(sentence);
    const confidenceContext = CONFIDENCE_TERMS.test(sentence);
    for (const clause of contrastClauses(sentence)) {
      if (fundingContext && OWNERSHIP_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "funding_ownership_overclaim",
          severity: "critical",
          message: "Funding evidence was promoted to common ownership/control without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (fundingContext && INSIDER_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "funding_insider_overclaim",
          severity: "critical",
          message: "Funding evidence was promoted to insider status without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (coordinationContext && INSIDER_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "coordination_insider_overclaim",
          severity: "critical",
          message: "Coordination/coactivity was promoted to insider control without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (coordinationContext && OWNERSHIP_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "coordination_ownership_overclaim",
          severity: "critical",
          message: "Coordination/coactivity was promoted to common ownership/control without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (jitoContext && VERIFIED_BUNDLE_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "jito_bundle_overclaim",
          severity: "critical",
          message: "Jito/tip evidence was promoted to a verified atomic bundle.",
          excerpt: excerpt(clause),
        });
      }
      if (correlationContext && CAUSAL_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "correlation_causality_overclaim",
          severity: "high",
          message: "Correlation/backtest evidence was expressed as a causal relationship.",
          excerpt: excerpt(clause),
        });
      } else if (observationalContext && CAUSAL_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "observational_causality_overclaim",
          severity: "high",
          message: "Observational on-chain evidence was expressed as proven causality.",
          excerpt: excerpt(clause),
        });
      }
      if (confidenceContext && PROBABILITY_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "confidence_probability_overclaim",
          severity: "high",
          message: "Evidence confidence/score was promoted to a probability of a future outcome.",
          excerpt: excerpt(clause),
        });
      }
      if (ABSOLUTE_FUTURE_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "deterministic_future_prediction",
          severity: "high",
          message: "The report makes a deterministic future-price/outcome claim that the evidence contract does not support.",
          excerpt: excerpt(clause),
        });
      }
    }
  }
  const socialSentence = sentences.find((sentence) => SOCIAL_CLAIM_TERMS.test(sentence) && !SOCIAL_UNKNOWN_TERMS.test(sentence) && unhedged(sentence));
  if (socialSentence) {
    pushUnique(violations, {
      code: "unsupported_social_claim",
      severity: "high",
      message: "Blockchain-only report introduced an unsupported social/Telegram/X claim.",
      excerpt: excerpt(socialSentence),
    });
  }
  const injectionSentence = sentences.find((sentence) => PROMPT_INJECTION_ARTIFACT.test(sentence) && !PROMPT_INJECTION_SAFE_CONTEXT.test(sentence));
  if (injectionSentence) {
    pushUnique(violations, {
      code: "prompt_injection_artifact",
      severity: "critical",
      message: "AI output contains an instruction-following artifact that should never be treated as blockchain analysis.",
      excerpt: excerpt(injectionSentence),
    });
  }
  return violations;
}

export function evaluateBlockchainAiReport(
  snapshot: GuardSnapshot,
  report: GuardableAiReport,
): AiReportGuardResult {
  const violations: AiReportGuardViolation[] = [];
  const sentences = allSentences(report);

  for (const sentence of sentences) {
    const fundingContext = FUNDING_TERMS.test(sentence);
    const coordinationContext = COORDINATION_TERMS.test(sentence);
    const jitoContext = JITO_TERMS.test(sentence);
    const correlationContext = CORRELATION_TERMS.test(sentence);
    const observationalContext = OBSERVATIONAL_SIGNAL_TERMS.test(sentence);
    const confidenceContext = CONFIDENCE_TERMS.test(sentence);
    for (const clause of contrastClauses(sentence)) {
      if (fundingContext && OWNERSHIP_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "funding_ownership_overclaim",
          severity: "critical",
          message: "Funding evidence was promoted to common ownership/control without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (fundingContext && INSIDER_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "funding_insider_overclaim",
          severity: "critical",
          message: "Funding evidence was promoted to insider status without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (coordinationContext && INSIDER_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "coordination_insider_overclaim",
          severity: "critical",
          message: "Coordination/coactivity was promoted to insider control without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (coordinationContext && OWNERSHIP_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "coordination_ownership_overclaim",
          severity: "critical",
          message: "Coordination/coactivity was promoted to common ownership/control without sufficient qualification.",
          excerpt: excerpt(clause),
        });
      }
      if (jitoContext && VERIFIED_BUNDLE_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "jito_bundle_overclaim",
          severity: "critical",
          message: "Jito/tip evidence was promoted to a verified atomic bundle.",
          excerpt: excerpt(clause),
        });
      }
      if (correlationContext && CAUSAL_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "correlation_causality_overclaim",
          severity: "high",
          message: "Correlation/backtest evidence was expressed as a causal relationship.",
          excerpt: excerpt(clause),
        });
      } else if (observationalContext && CAUSAL_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "observational_causality_overclaim",
          severity: "high",
          message: "Observational on-chain evidence was expressed as proven causality.",
          excerpt: excerpt(clause),
        });
      }
      if (confidenceContext && PROBABILITY_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "confidence_probability_overclaim",
          severity: "high",
          message: "Evidence confidence/score was promoted to a probability of a future outcome.",
          excerpt: excerpt(clause),
        });
      }
      if (ABSOLUTE_FUTURE_TERMS.test(clause) && unhedged(clause)) {
        pushUnique(violations, {
          code: "deterministic_future_prediction",
          severity: "high",
          message: "The report makes a deterministic future-price/outcome claim that the evidence contract does not support.",
          excerpt: excerpt(clause),
        });
      }
    }
  }


  const socialState = report.finalIntelligence?.socialState;
  if (typeof socialState === "string" && socialState.trim() && !SOCIAL_UNKNOWN_TERMS.test(socialState)) {
    pushUnique(violations, {
      code: "unsupported_social_claim",
      severity: "high",
      message: "Blockchain-only report produced a social/Telegram/X assessment without social evidence in the snapshot.",
      excerpt: excerpt(socialState),
    });
  }
  const socialSentence = sentences.find((sentence) => SOCIAL_CLAIM_TERMS.test(sentence) && !SOCIAL_UNKNOWN_TERMS.test(sentence) && unhedged(sentence));
  if (socialSentence) {
    pushUnique(violations, {
      code: "unsupported_social_claim",
      severity: "high",
      message: "Blockchain-only report introduced an unsupported social/Telegram/X claim.",
      excerpt: excerpt(socialSentence),
    });
  }
  const injectionSentence = sentences.find((sentence) => PROMPT_INJECTION_ARTIFACT.test(sentence) && !PROMPT_INJECTION_SAFE_CONTEXT.test(sentence));
  if (injectionSentence) {
    pushUnique(violations, {
      code: "prompt_injection_artifact",
      severity: "critical",
      message: "AI output contains an instruction-following artifact that should never be treated as blockchain analysis.",
      excerpt: excerpt(injectionSentence),
    });
  }

  const snapshotUnknownCount = Array.isArray(snapshot.unknowns) ? snapshot.unknowns.length : 0;
  if (snapshotUnknownCount > 0) {
    const safeSentence = sentences.find((sentence) => SAFE_TERMS.test(sentence) && unhedged(sentence));
    if (safeSentence) {
      pushUnique(violations, {
        code: "unknown_promoted_to_safe",
        severity: "high",
        message: "The report claims safety/no-risk while the snapshot contains unresolved unknown evidence.",
        excerpt: excerpt(safeSentence),
      });
    }
  }

  const quality = evidenceQuality(snapshot);
  const cap = confidenceCap(snapshot, quality.quality);
  const confidenceCandidates = [
    normalizeConfidence(report.overallConfidence),
    normalizeConfidence(report.finalIntelligence?.confidence),
  ].filter((value): value is number => value != null);
  const reported = confidenceCandidates.length ? Math.max(...confidenceCandidates) : null;
  if (reported != null && reported > cap + 1e-9) {
    pushUnique(violations, {
      code: "confidence_exceeds_evidence_cap",
      severity: "medium",
      message: `Reported confidence ${(reported * 100).toFixed(0)}% exceeds evidence-aware cap ${(cap * 100).toFixed(0)}%.`,
    });
  }

  const snapshotContradictions = Number(snapshot.headline?.contradictions || 0);
  const reportedContradictions = (report.contradictions || []).filter((row) => typeof row.statement === "string" && row.statement.trim()).length;
  const contradictionSection = report.sectionReports?.contradictions?.trim();
  if (snapshotContradictions > 0 && reportedContradictions === 0 && !contradictionSection) {
    pushUnique(violations, {
      code: "contradictions_omitted",
      severity: "medium",
      message: `Snapshot contains ${snapshotContradictions} contradiction(s), but the AI report did not surface them.`,
    });
  }

  const reportedUnknowns = (report.finalIntelligence?.unknowns || []).filter((row) => typeof row === "string" && row.trim()).length;
  const unknownSection = report.sectionReports?.unknowns?.trim();
  if (snapshotUnknownCount > 0 && reportedUnknowns === 0 && !unknownSection) {
    pushUnique(violations, {
      code: "unknowns_omitted",
      severity: "medium",
      message: `Snapshot contains ${snapshotUnknownCount} unknown/partial evidence item(s), but the AI report did not surface them.`,
    });
  }

  if (snapshot.compactMeta?.payloadTruncated) {
    const disclosed = sentences.some((sentence) => TRUNCATION_DISCLOSURE.test(sentence));
    if (!disclosed) {
      pushUnique(violations, {
        code: "transport_compaction_not_disclosed",
        severity: "medium",
        message: "The snapshot was transport-compacted, but the AI report did not disclose reduced drill-down detail.",
      });
    }
  }

  const required = Array.isArray(snapshot.reportContract?.requiredSections) ? snapshot.reportContract.requiredSections : [];
  const present = required.filter((key) => typeof report.sectionReports?.[key] === "string" && report.sectionReports[key]!.trim()).length;
  if (required.length > 0 && present < Math.ceil(required.length * 0.6)) {
    pushUnique(violations, {
      code: "required_sections_missing",
      severity: "medium",
      message: `Only ${present}/${required.length} required report sections were returned.`,
    });
  }

  const hasCritical = violations.some((row) => row.severity === "critical");
  const hasWarn = violations.length > 0;
  const status: AiReportGuardResult["status"] = hasCritical ? "reject" : hasWarn ? "warn" : "pass";
  const effectiveConfidence = reported == null ? null : Math.min(reported, cap);

  return {
    status,
    evidenceQuality01: quality.quality,
    confidenceCap01: cap,
    reportedConfidence01: reported,
    effectiveConfidence01: effectiveConfidence,
    violations,
    checks: {
      evidenceRows: quality.rows,
      completeEvidenceRows: quality.complete,
      partialEvidenceRows: quality.partial,
      unavailableEvidenceRows: quality.unavailable,
      requiredSectionsPresent: present,
      requiredSectionsTotal: required.length,
    },
  };
}
