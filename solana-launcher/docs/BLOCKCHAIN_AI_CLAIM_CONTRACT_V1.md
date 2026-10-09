# Blockchain AI Claim Contract V1

## Purpose

`blockchain-ai-v1.1` adds a machine-verifiable claim layer on top of the deterministic blockchain snapshot and the existing post-model text guard.

The model may still return the legacy prose report, but a fully verified report should also return `claims[]`. Each claim states what is being asserted, what snapshot evidence supports it, its time scope and confidence.

## Claim schema

```ts
{
  id: string;
  claim: string;
  claimType:
    | "observed_fact"
    | "interpretation"
    | "association"
    | "risk_assessment"
    | "temporal_backtest"
    | "limitation"
    | "future_outlook";
  evidenceKeys: string[];
  evidenceAssertions?: Array<{
    key: string;
    operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "is_null" | "not_null";
    value?: string | number | boolean | null;
    tolerance?: number;
  }>;
  confidence: number; // share01
  timeScope: "current" | "historical" | "temporal_backtest" | "future_conditional" | "unspecified";
  qualifiers?: string[];
}
```

## Evidence namespaces

Claims may cite exact keys exposed by the snapshot:

- `facts[].key`, e.g. `flow.ofi_15m`, `score.distributionRisk`, `temporal.1h.demand.spearman`;
- `evidence.<name>` for source availability / completeness / coverage;
- `section.<name>` for broad structured evidence;
- `unknown.<N>` for explicit unknowns;
- `warning.<N>` for explicit warnings.

The compatibility transport also emits `blockchain.claim_evidence_index` so the model receives the exact currently valid evidence keys without inventing references.

## Verification layers

### 1. Text semantic guard

The existing guard still checks overclaims such as:

- funding => ownership / insider;
- coordination => ownership / insider;
- Jito tip => verified atomic bundle;
- correlation/backtest => causality;
- confidence => future probability;
- deterministic price prediction;
- unknown evidence => safe/risk-free;
- unsupported social claims;
- prompt-injection artifacts.

### 2. Evidence provenance

For every structured claim the server verifies that:

- cited evidence keys exist;
- cited values are available, not `null` / unavailable;
- temporal claims cite temporal evidence;
- observed facts do not rely only on a broad section key;
- limitation claims reference appropriate unknown / warning / evidence-quality context;
- the claim confidence does not exceed the weakest cited evidence cap.

### 3. Evidence assertions

Optional `evidenceAssertions` make scalar claims machine-checkable.

Example:

```json
{
  "claim": "OFI 15m is positive",
  "claimType": "observed_fact",
  "evidenceKeys": ["flow.ofi_15m"],
  "evidenceAssertions": [
    { "key": "flow.ofi_15m", "operator": "gt", "value": 0 }
  ],
  "confidence": 0.7,
  "timeScope": "current"
}
```

If the actual snapshot contains `flow.ofi_15m = -0.2`, the assertion fails even though the evidence key itself is valid.

## Backward compatibility

A provider that does not yet return `claims[]` is not hard-failed. The result becomes:

- claim status: `missing`;
- verification mode: `text_guard_only`;
- effective confidence capped at `0.65`.

This avoids breaking the existing AI provider while making the lack of structured verification explicit.

## Combined verification

The report endpoint returns one summary in addition to the detailed guards:

```ts
verification: {
  status: "verified" | "warn" | "text_guard_only" | "reject";
  usable: boolean;
  effectiveConfidence01: number | null;
  textGuardStatus: "pass" | "warn" | "reject";
  claimAuditStatus: "verified" | "partial" | "missing" | "reject";
  claimVerificationMode: "claim_verified" | "text_guard_only";
}
```

`usable=false` whenever either the text guard or claim audit rejects the report.

## Important limitation

Evidence-key validation and scalar assertions do not prove arbitrary natural-language entailment. They substantially reduce unsupported and inverted claims, but a free-form interpretation can still overstate what a valid set of facts logically implies. For that reason the text semantic guard remains active in parallel with claim verification.
