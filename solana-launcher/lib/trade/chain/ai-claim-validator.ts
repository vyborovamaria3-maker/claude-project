import type { BlockchainAiCompactSnapshot } from "./ai-snapshot";
import {
  evaluateBlockchainAiTextOverclaims,
  type AiReportGuardViolation,
} from "./ai-report-guard";

export const BLOCKCHAIN_AI_CLAIM_CONTRACT_VERSION = "blockchain-claim-v1" as const;

export const AI_CLAIM_TYPES = [
  "observed_fact",
  "interpretation",
  "association",
  "risk_assessment",
  "temporal_backtest",
  "limitation",
  "future_outlook",
] as const;
export type AiClaimType = (typeof AI_CLAIM_TYPES)[number];

export const AI_CLAIM_TIME_SCOPES = [
  "current",
  "historical",
  "temporal_backtest",
  "future_conditional",
  "unspecified",
] as const;
export type AiClaimTimeScope = (typeof AI_CLAIM_TIME_SCOPES)[number];

export const AI_EVIDENCE_ASSERTION_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "is_null", "not_null"] as const;
export type AiEvidenceAssertionOperator = (typeof AI_EVIDENCE_ASSERTION_OPERATORS)[number];

export type NormalizedEvidenceAssertion = {
  key: string;
  operator: AiEvidenceAssertionOperator;
  value: string | number | boolean | null;
  tolerance: number | null;
};

export type NormalizedAiClaim = {
  id: string;
  claim: string;
  claimType: AiClaimType;
  evidenceKeys: string[];
  evidenceAssertions: NormalizedEvidenceAssertion[];
  confidence01: number | null;
  timeScope: AiClaimTimeScope;
  qualifiers: string[];
};

export type ClaimParseIssue = {
  index: number;
  code: "claim_not_object" | "claim_text_missing" | "claim_type_invalid" | "time_scope_invalid" | "evidence_keys_invalid" | "evidence_assertions_invalid";
  message: string;
};

export type ClaimEvidenceKind = "fact" | "evidence_status" | "section" | "unknown" | "warning";

export type ClaimEvidenceDescriptor = {
  key: string;
  kind: ClaimEvidenceKind;
  available: boolean;
  complete: boolean | null;
  coverage01: number | null;
  confidence01: number | null;
  ageMs: number | null;
  valueKnown: boolean;
  value: string | number | boolean | null;
  semanticTags: string[];
};

export type AiClaimAuditViolationCode =
  | "claims_missing"
  | "claim_parse_error"
  | "claim_missing_evidence"
  | "claim_unknown_evidence_key"
  | "claim_unavailable_evidence"
  | "claim_partial_evidence_overconfidence"
  | "claim_confidence_exceeds_cap"
  | "claim_observed_fact_uses_only_section"
  | "claim_temporal_without_temporal_evidence"
  | "claim_future_scope_mismatch"
  | "claim_limitation_without_limit_evidence"
  | "claim_assertion_key_not_cited"
  | "claim_assertion_non_scalar_evidence"
  | "claim_evidence_assertion_failed"
  | "claim_text_overclaim";

export type AiClaimAuditViolation = {
  code: AiClaimAuditViolationCode;
  severity: "medium" | "high" | "critical";
  claimId?: string;
  message: string;
  evidenceKeys?: string[];
  excerpt?: string;
  textGuardCode?: AiReportGuardViolation["code"];
};

export type AiClaimAuditRow = {
  id: string;
  claim: string;
  claimType: AiClaimType;
  timeScope: AiClaimTimeScope;
  evidenceKeys: string[];
  evidenceAssertions: NormalizedEvidenceAssertion[];
  validEvidenceKeys: string[];
  unknownEvidenceKeys: string[];
  unavailableEvidenceKeys: string[];
  evidenceCap01: number;
  reportedConfidence01: number | null;
  effectiveConfidence01: number | null;
  status: "verified" | "warn" | "reject";
  violations: AiClaimAuditViolation[];
};

export type AiClaimAuditResult = {
  contractVersion: typeof BLOCKCHAIN_AI_CLAIM_CONTRACT_VERSION;
  status: "verified" | "partial" | "missing" | "reject";
  mode: "claim_verified" | "text_guard_only";
  confidenceCap01: number;
  effectiveConfidence01: number | null;
  claimsReceived: number;
  claimsVerified: number;
  claimsWarned: number;
  claimsRejected: number;
  evidenceKeysAvailable: number;
  parseIssues: ClaimParseIssue[];
  violations: AiClaimAuditViolation[];
  claims: AiClaimAuditRow[];
};

const FUTURE_TERMS = /(?:future|will\s+(?:rise|fall|pump|dump|grow|crash)|upside|downside|next\s+(?:5m|15m|1h|6h|24h)|будущ|вырастет|упад[её]т|роста|падения)/iu;
const LIMITATION_TERMS = /(?:unknown|unavailable|partial|insufficient|missing|uncertain|limitation|неизвест|недоступ|частич|недостаточ|отсутств|неопредел)/iu;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeConfidence(value: unknown): number | null {
  if (!finite(value) || value < 0) return null;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return null;
}

function nonEmptyString(value: unknown, max = 4_000): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!clean) return null;
  return clean.length <= max ? clean : `${clean.slice(0, max)}…[truncated]`;
}

function stringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = nonEmptyString(item, maxChars);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function isClaimType(value: unknown): value is AiClaimType {
  return typeof value === "string" && (AI_CLAIM_TYPES as readonly string[]).includes(value);
}

function isTimeScope(value: unknown): value is AiClaimTimeScope {
  return typeof value === "string" && (AI_CLAIM_TIME_SCOPES as readonly string[]).includes(value);
}

function isAssertionOperator(value: unknown): value is AiEvidenceAssertionOperator {
  return typeof value === "string" && (AI_EVIDENCE_ASSERTION_OPERATORS as readonly string[]).includes(value);
}

function normalizeEvidenceAssertions(value: unknown, claimIndex: number, parseIssues: ClaimParseIssue[]): NormalizedEvidenceAssertion[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    parseIssues.push({ index: claimIndex, code: "evidence_assertions_invalid", message: `claims[${claimIndex}].evidenceAssertions must be an array` });
    return [];
  }
  const out: NormalizedEvidenceAssertion[] = [];
  for (const item of value.slice(0, 24)) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      parseIssues.push({ index: claimIndex, code: "evidence_assertions_invalid", message: `claims[${claimIndex}] contains a malformed evidence assertion` });
      continue;
    }
    const row = item as Record<string, unknown>;
    const key = nonEmptyString(row.key, 180);
    const operator = row.operator ?? row.op;
    if (!key || !isAssertionOperator(operator)) {
      parseIssues.push({ index: claimIndex, code: "evidence_assertions_invalid", message: `claims[${claimIndex}] evidence assertion requires a valid key/operator` });
      continue;
    }
    const scalar = row.value;
    const normalizedValue = scalar == null || typeof scalar === "string" || typeof scalar === "boolean" || finite(scalar) ? (scalar as string | number | boolean | null) : null;
    const tolerance = finite(row.tolerance) && row.tolerance >= 0 ? row.tolerance : null;
    out.push({ key, operator, value: normalizedValue, tolerance });
  }
  return out;
}

export function normalizeAiClaims(value: unknown, maxClaims = 40): { claims: NormalizedAiClaim[]; parseIssues: ClaimParseIssue[] } {
  if (value == null) return { claims: [], parseIssues: [] };
  if (!Array.isArray(value)) {
    return {
      claims: [],
      parseIssues: [{ index: -1, code: "claim_not_object", message: "claims must be an array" }],
    };
  }

  const claims: NormalizedAiClaim[] = [];
  const parseIssues: ClaimParseIssue[] = [];
  for (let index = 0; index < Math.min(value.length, maxClaims); index++) {
    const item = value[index];
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      parseIssues.push({ index, code: "claim_not_object", message: `claims[${index}] must be an object` });
      continue;
    }
    const row = item as Record<string, unknown>;
    const claim = nonEmptyString(row.claim ?? row.statement ?? row.text, 4_000);
    if (!claim) {
      parseIssues.push({ index, code: "claim_text_missing", message: `claims[${index}] is missing claim text` });
      continue;
    }

    const rawType = row.claimType ?? row.type;
    const claimType: AiClaimType = isClaimType(rawType) ? rawType : "interpretation";
    if (rawType != null && !isClaimType(rawType)) {
      parseIssues.push({ index, code: "claim_type_invalid", message: `claims[${index}].claimType is invalid` });
    }

    const rawTimeScope = row.timeScope;
    const timeScope: AiClaimTimeScope = isTimeScope(rawTimeScope) ? rawTimeScope : "unspecified";
    if (rawTimeScope != null && !isTimeScope(rawTimeScope)) {
      parseIssues.push({ index, code: "time_scope_invalid", message: `claims[${index}].timeScope is invalid` });
    }

    const evidenceKeys = stringArray(row.evidenceKeys ?? row.evidence, 24, 180);
    if ((row.evidenceKeys ?? row.evidence) != null && !Array.isArray(row.evidenceKeys ?? row.evidence)) {
      parseIssues.push({ index, code: "evidence_keys_invalid", message: `claims[${index}].evidenceKeys must be an array` });
    }

    const evidenceAssertions = normalizeEvidenceAssertions(row.evidenceAssertions, index, parseIssues);
    const qualifiers = stringArray(row.qualifiers, 12, 512);
    const rawId = nonEmptyString(row.id, 120);
    const id = rawId || `claim-${String(index + 1).padStart(3, "0")}`;
    claims.push({
      id,
      claim,
      claimType,
      evidenceKeys,
      evidenceAssertions,
      confidence01: normalizeConfidence(row.confidence01 ?? row.confidence),
      timeScope,
      qualifiers,
    });
  }
  return { claims, parseIssues };
}

function semanticTagsForKey(key: string): string[] {
  const tags: string[] = [];
  if (/^funding\.|^evidence\.funding|^section\.funding/u.test(key)) tags.push("funding");
  if (/coordination|coactivity|cluster/u.test(key)) tags.push("coordination");
  if (/^bundles\.|bundle/u.test(key)) tags.push("bundle");
  if (/wash/u.test(key)) tags.push("wash");
  if (/^temporal\.|^section\.temporal|backtest|outcome/u.test(key)) tags.push("temporal");
  if (/^dev\.|^section\.devHistory|creator/u.test(key)) tags.push("dev_history");
  if (/^score\./u.test(key)) tags.push("score");
  if (/^unknown\./u.test(key)) tags.push("unknown");
  if (/^warning\./u.test(key)) tags.push("warning");
  return tags;
}

function factDescriptor(snapshot: BlockchainAiCompactSnapshot, key: string): ClaimEvidenceDescriptor | null {
  const row = snapshot.facts.find((item) => item.key === key);
  if (!row) return null;
  return {
    key,
    kind: "fact",
    available: row.value != null,
    complete: null,
    coverage01: normalizeConfidence(row.coverage),
    confidence01: normalizeConfidence(row.confidence),
    ageMs: null,
    valueKnown: row.value != null,
    value: row.value,
    semanticTags: semanticTagsForKey(key),
  };
}

export function buildClaimEvidenceCatalog(snapshot: BlockchainAiCompactSnapshot): Map<string, ClaimEvidenceDescriptor> {
  const catalog = new Map<string, ClaimEvidenceDescriptor>();
  for (const row of snapshot.facts) {
    const descriptor = factDescriptor(snapshot, row.key);
    if (descriptor) catalog.set(row.key, descriptor);
  }
  for (const [name, row] of Object.entries(snapshot.dataQuality.evidence || {})) {
    const key = `evidence.${name}`;
    catalog.set(key, {
      key,
      kind: "evidence_status",
      available: row.available === true,
      complete: row.complete === true,
      coverage01: finite(row.coveragePct) && row.coveragePct >= 0 && row.coveragePct <= 100 ? row.coveragePct / 100 : null,
      confidence01: null,
      ageMs: finite(row.ageMs) && row.ageMs >= 0 ? row.ageMs : null,
      valueKnown: row.available === true,
      value: row.available === true,
      semanticTags: semanticTagsForKey(key),
    });
  }
  for (const [name, value] of Object.entries(snapshot.sections || {})) {
    const key = `section.${name}`;
    catalog.set(key, {
      key,
      kind: "section",
      available: value != null,
      complete: null,
      coverage01: null,
      confidence01: null,
      ageMs: null,
      valueKnown: value != null,
      value: value != null,
      semanticTags: semanticTagsForKey(key),
    });
  }
  snapshot.unknowns.forEach((_, index) => {
    const key = `unknown.${index + 1}`;
    catalog.set(key, {
      key,
      kind: "unknown",
      available: true,
      complete: false,
      coverage01: null,
      confidence01: null,
      ageMs: null,
      valueKnown: true,
      value: true,
      semanticTags: ["unknown"],
    });
  });
  snapshot.warnings.forEach((_, index) => {
    const key = `warning.${index + 1}`;
    catalog.set(key, {
      key,
      kind: "warning",
      available: true,
      complete: null,
      coverage01: null,
      confidence01: null,
      ageMs: null,
      valueKnown: true,
      value: true,
      semanticTags: ["warning"],
    });
  });
  return catalog;
}

function descriptorQuality(row: ClaimEvidenceDescriptor, globalCap01: number): number {
  if (!row.available || !row.valueKnown) return 0;
  if (row.kind === "unknown" || row.kind === "warning") return globalCap01;
  const coverage = row.coverage01 ?? globalCap01;
  const confidence = row.confidence01 ?? globalCap01;
  const completePenalty = row.complete === false ? 0.8 : 1;
  const stalePenalty = row.ageMs != null && row.ageMs > 30 * 60_000 ? 0.8 : 1;
  return clamp01(Math.min(globalCap01, coverage, confidence) * completePenalty * stalePenalty);
}

function pushUnique(target: AiClaimAuditViolation[], row: AiClaimAuditViolation): void {
  if (!target.some((item) => item.code === row.code && item.claimId === row.claimId && item.excerpt === row.excerpt)) target.push(row);
}

function isLimitationEvidence(row: ClaimEvidenceDescriptor): boolean {
  return row.kind === "unknown" || row.kind === "warning" || row.kind === "evidence_status";
}

function hasTemporalEvidence(rows: ClaimEvidenceDescriptor[]): boolean {
  return rows.some((row) => row.semanticTags.includes("temporal"));
}

function assertionMatches(assertion: NormalizedEvidenceAssertion, descriptor: ClaimEvidenceDescriptor): boolean | null {
  const actual = descriptor.kind === "fact" ? descriptor.value : null;
  if (descriptor.kind !== "fact") return null;
  if (assertion.operator === "is_null") return actual == null;
  if (assertion.operator === "not_null") return actual != null;
  if (actual == null) return false;
  if (assertion.operator === "eq" || assertion.operator === "neq") {
    let equal: boolean;
    if (typeof actual === "number" && typeof assertion.value === "number") {
      const tolerance = assertion.tolerance ?? Math.max(1e-9, Math.abs(assertion.value) * 1e-6);
      equal = Math.abs(actual - assertion.value) <= tolerance;
    } else {
      equal = actual === assertion.value;
    }
    return assertion.operator === "eq" ? equal : !equal;
  }
  if (typeof actual !== "number" || typeof assertion.value !== "number") return false;
  if (assertion.operator === "gt") return actual > assertion.value;
  if (assertion.operator === "gte") return actual >= assertion.value;
  if (assertion.operator === "lt") return actual < assertion.value;
  if (assertion.operator === "lte") return actual <= assertion.value;
  return false;
}

export function evaluateBlockchainAiClaims(args: {
  snapshot: BlockchainAiCompactSnapshot;
  claims: NormalizedAiClaim[];
  parseIssues?: ClaimParseIssue[];
  globalConfidenceCap01: number;
  reportConfidence01?: number | null;
}): AiClaimAuditResult {
  const globalCap = clamp01(args.globalConfidenceCap01);
  const parseIssues = args.parseIssues || [];
  const catalog = buildClaimEvidenceCatalog(args.snapshot);
  const globalViolations: AiClaimAuditViolation[] = parseIssues.map((issue) => ({
    code: "claim_parse_error",
    severity: "medium",
    message: issue.message,
  }));

  if (args.claims.length === 0) {
    const fallbackCap = Math.min(globalCap, 0.65);
    globalViolations.push({
      code: "claims_missing",
      severity: "medium",
      message: "AI report did not return structured claims; only text-level reasoning guard can be applied.",
    });
    return {
      contractVersion: BLOCKCHAIN_AI_CLAIM_CONTRACT_VERSION,
      status: "missing",
      mode: "text_guard_only",
      confidenceCap01: fallbackCap,
      effectiveConfidence01: args.reportConfidence01 == null ? null : Math.min(args.reportConfidence01, fallbackCap),
      claimsReceived: 0,
      claimsVerified: 0,
      claimsWarned: 0,
      claimsRejected: 0,
      evidenceKeysAvailable: catalog.size,
      parseIssues,
      violations: globalViolations,
      claims: [],
    };
  }

  const audited: AiClaimAuditRow[] = [];
  for (const claim of args.claims) {
    const violations: AiClaimAuditViolation[] = [];
    const descriptors = claim.evidenceKeys.map((key) => catalog.get(key)).filter((row): row is ClaimEvidenceDescriptor => row != null);
    const unknownKeys = claim.evidenceKeys.filter((key) => !catalog.has(key));
    const unavailableKeys = descriptors.filter((row) => !row.available || !row.valueKnown).map((row) => row.key);
    const validKeys = descriptors.filter((row) => row.available && row.valueKnown).map((row) => row.key);

    if (claim.claimType !== "limitation" && claim.evidenceKeys.length === 0) {
      pushUnique(violations, {
        code: "claim_missing_evidence",
        severity: "high",
        claimId: claim.id,
        message: "Non-limitation claim has no evidenceKeys.",
      });
    }
    if (unknownKeys.length > 0) {
      pushUnique(violations, {
        code: "claim_unknown_evidence_key",
        severity: "high",
        claimId: claim.id,
        message: `Claim references ${unknownKeys.length} evidence key(s) that do not exist in this snapshot.`,
        evidenceKeys: unknownKeys,
      });
    }
    if (claim.claimType !== "limitation" && unavailableKeys.length > 0) {
      pushUnique(violations, {
        code: "claim_unavailable_evidence",
        severity: "high",
        claimId: claim.id,
        message: "Claim relies on unavailable/null evidence.",
        evidenceKeys: unavailableKeys,
      });
    }
    if (claim.claimType === "observed_fact" && descriptors.length > 0 && descriptors.every((row) => row.kind === "section")) {
      pushUnique(violations, {
        code: "claim_observed_fact_uses_only_section",
        severity: "medium",
        claimId: claim.id,
        message: "Observed-fact claim cites only a broad section; cite at least one exact AiFact/evidence key.",
        evidenceKeys: claim.evidenceKeys,
      });
    }
    if ((claim.claimType === "temporal_backtest" || claim.timeScope === "temporal_backtest") && !hasTemporalEvidence(descriptors)) {
      pushUnique(violations, {
        code: "claim_temporal_without_temporal_evidence",
        severity: "high",
        claimId: claim.id,
        message: "Temporal/backtest claim does not cite temporal evidence.",
        evidenceKeys: claim.evidenceKeys,
      });
    }
    if (claim.claimType === "future_outlook" && claim.timeScope !== "future_conditional") {
      pushUnique(violations, {
        code: "claim_future_scope_mismatch",
        severity: "medium",
        claimId: claim.id,
        message: "Future-outlook claim must use timeScope=future_conditional.",
      });
    }
    if (claim.claimType === "limitation" && descriptors.length > 0 && !descriptors.some(isLimitationEvidence) && !LIMITATION_TERMS.test(claim.claim)) {
      pushUnique(violations, {
        code: "claim_limitation_without_limit_evidence",
        severity: "medium",
        claimId: claim.id,
        message: "Limitation claim does not cite unknown/warning/evidence-status keys.",
        evidenceKeys: claim.evidenceKeys,
      });
    }

    for (const assertion of claim.evidenceAssertions) {
      if (!claim.evidenceKeys.includes(assertion.key)) {
        pushUnique(violations, {
          code: "claim_assertion_key_not_cited",
          severity: "medium",
          claimId: claim.id,
          message: "Evidence assertion key must also appear in evidenceKeys.",
          evidenceKeys: [assertion.key],
        });
      }
      const descriptor = catalog.get(assertion.key);
      if (!descriptor) continue;
      const matches = assertionMatches(assertion, descriptor);
      if (matches == null) {
        pushUnique(violations, {
          code: "claim_assertion_non_scalar_evidence",
          severity: "medium",
          claimId: claim.id,
          message: "Machine-checkable evidence assertions can only target exact scalar AiFact keys.",
          evidenceKeys: [assertion.key],
        });
      } else if (!matches) {
        pushUnique(violations, {
          code: "claim_evidence_assertion_failed",
          severity: "high",
          claimId: claim.id,
          message: `Evidence assertion failed for ${assertion.key}.`,
          evidenceKeys: [assertion.key],
        });
      }
    }

    for (const textViolation of evaluateBlockchainAiTextOverclaims(claim.claim)) {
      pushUnique(violations, {
        code: "claim_text_overclaim",
        severity: textViolation.severity,
        claimId: claim.id,
        message: textViolation.message,
        excerpt: textViolation.excerpt,
        textGuardCode: textViolation.code,
      });
    }

    const evidenceQualities = descriptors
      .filter((row) => row.available && row.valueKnown && row.kind !== "unknown" && row.kind !== "warning")
      .map((row) => descriptorQuality(row, globalCap));
    let evidenceCap = evidenceQualities.length ? Math.min(globalCap, ...evidenceQualities) : globalCap;
    if (claim.claimType === "future_outlook") evidenceCap = Math.min(evidenceCap, 0.6);
    if (claim.claimType === "limitation") evidenceCap = globalCap;
    evidenceCap = clamp01(evidenceCap);

    if (claim.confidence01 != null && claim.confidence01 > evidenceCap + 1e-9) {
      const partial = descriptors.some((row) => row.complete === false || (row.coverage01 != null && row.coverage01 < 0.999));
      pushUnique(violations, {
        code: partial ? "claim_partial_evidence_overconfidence" : "claim_confidence_exceeds_cap",
        severity: "medium",
        claimId: claim.id,
        message: `Claim confidence ${(claim.confidence01 * 100).toFixed(0)}% exceeds evidence-aware cap ${(evidenceCap * 100).toFixed(0)}%.`,
        evidenceKeys: claim.evidenceKeys,
      });
    }

    if (claim.claimType !== "future_outlook" && claim.timeScope === "future_conditional" && !FUTURE_TERMS.test(claim.claim)) {
      pushUnique(violations, {
        code: "claim_future_scope_mismatch",
        severity: "medium",
        claimId: claim.id,
        message: "Claim uses future_conditional timeScope but is not typed as future_outlook.",
      });
    }

    const hasCritical = violations.some((row) => row.severity === "critical");
    const hasHigh = violations.some((row) => row.severity === "high");
    const status: AiClaimAuditRow["status"] = hasCritical ? "reject" : hasHigh || violations.length > 0 ? "warn" : "verified";
    audited.push({
      id: claim.id,
      claim: claim.claim,
      claimType: claim.claimType,
      timeScope: claim.timeScope,
      evidenceKeys: claim.evidenceKeys,
      evidenceAssertions: claim.evidenceAssertions,
      validEvidenceKeys: validKeys,
      unknownEvidenceKeys: unknownKeys,
      unavailableEvidenceKeys: unavailableKeys,
      evidenceCap01: evidenceCap,
      reportedConfidence01: claim.confidence01,
      effectiveConfidence01: claim.confidence01 == null ? null : Math.min(claim.confidence01, evidenceCap),
      status,
      violations,
    });
  }

  const allViolations = [...globalViolations, ...audited.flatMap((row) => row.violations)];
  const rejected = audited.filter((row) => row.status === "reject").length;
  const warned = audited.filter((row) => row.status === "warn").length;
  const verified = audited.filter((row) => row.status === "verified").length;
  const severeParseIssue = parseIssues.length > 0;
  const status: AiClaimAuditResult["status"] = rejected > 0
    ? "reject"
    : warned > 0 || severeParseIssue
      ? "partial"
      : "verified";
  const claimCaps = audited.map((row) => row.evidenceCap01);
  const auditCap = claimCaps.length ? Math.min(globalCap, ...claimCaps) : globalCap;
  const effectiveConfidence = args.reportConfidence01 == null ? null : Math.min(args.reportConfidence01, auditCap);

  return {
    contractVersion: BLOCKCHAIN_AI_CLAIM_CONTRACT_VERSION,
    status,
    mode: "claim_verified",
    confidenceCap01: auditCap,
    effectiveConfidence01: effectiveConfidence,
    claimsReceived: audited.length,
    claimsVerified: verified,
    claimsWarned: warned,
    claimsRejected: rejected,
    evidenceKeysAvailable: catalog.size,
    parseIssues,
    violations: allViolations,
    claims: audited,
  };
}
