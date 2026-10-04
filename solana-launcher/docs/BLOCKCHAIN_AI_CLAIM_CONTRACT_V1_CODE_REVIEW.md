# Blockchain AI Claim Contract V1 — Code Review

## Scope

This hardening pass starts from Blockchain AI Report Guard V1 and adds structured, evidence-aware claim verification without removing the existing free-text guard.

## Main improvement

The previous guard could detect dangerous wording, confidence inflation and omitted unknowns, but it could not answer a more basic provenance question: **which exact snapshot evidence is each AI conclusion based on?**

Claim Contract V1 adds that missing layer.

Every fully verifiable AI conclusion can now include:

- a claim id;
- claim type;
- exact `evidenceKeys`;
- optional machine-checkable `evidenceAssertions`;
- normalized confidence;
- time scope;
- qualifiers.

The server audits claims after the model returns them.

## Findings closed in this pass

### 1. Valid-looking prose could cite no evidence

Closed by `claim_missing_evidence` and the exact evidence-key catalog.

### 2. Model could invent an evidence key

Closed by `claim_unknown_evidence_key`.

### 3. Model could cite a real key whose value is null/unavailable

Closed by `claim_unavailable_evidence`.

### 4. Claim confidence could exceed the cited evidence coverage

Each claim receives its own evidence-aware confidence cap. Partial/stale evidence lowers the cap instead of being treated as full-strength evidence.

### 5. Temporal/backtest claim could cite only current-state evidence

Closed by `claim_temporal_without_temporal_evidence`.

### 6. Broad section citation could masquerade as an exact observed fact

`observed_fact` claims that cite only `section.*` are downgraded; exact `AiFact` keys are expected for scalar facts.

### 7. Correct evidence key could be used with an inverted scalar claim

This is the largest improvement over provenance-only validation.

Optional `evidenceAssertions` are evaluated server-side. Example:

```json
{"key":"flow.ofi_15m","operator":"gt","value":0}
```

If the snapshot value is `-0.2`, the claim fails even though the cited key exists.

### 8. Text guard and claim guard could diverge

The claim validator reuses `evaluateBlockchainAiTextOverclaims()` from the existing report guard. Funding/ownership, coordination/insider, correlation/causality and future-prediction semantics therefore have one implementation.

During regression development this shared primitive exposed a real bypass: causal wording such as `because of demand momentum` was not caught by the older `because of this` pattern. The causal matcher was widened while preserving the existing cautious-negative cases.

### 9. Structured-claim rollout could break an existing model

The new contract is backward compatible.

If the provider returns no `claims[]`:

- the report remains usable unless the old text guard rejects it;
- claim verification status is `missing`;
- mode is `text_guard_only`;
- effective confidence is capped at `0.65`.

### 10. Consumers had to combine two guard systems manually

The endpoint now returns a unified `verification` object with one usability/status/effective-confidence verdict.

## Evidence namespaces

The model receives exact valid keys via `blockchain.claim_evidence_index`:

- scalar `facts[].key`;
- `evidence.<name>`;
- `section.<name>`;
- `unknown.<N>`;
- `warning.<N>`.

This index is transported alongside the structured snapshot and claim contract.

## UI

Blockchain AI Report now surfaces:

- claim verification status;
- verified / warned / rejected claim counts;
- combined effective confidence;
- audited claims with cited evidence keys;
- explicit `text_guard_only` fallback when a provider has not adopted the claim schema.

## Performance

Synthetic 40-claim / ~140-evidence-key audit, 1,000 warm iterations:

- median: ~0.13 ms;
- p95: ~0.32 ms;
- p99: <1 ms in the final run.

Snapshot serialization remains around low-single-digit milliseconds and dominates neither RPC nor model inference.

## Validation

- Claim contract curated regression: PASS.
- Claim-level fuzz: 1,000 / 1,000 PASS.
  - 600 intentionally invalid claims caught.
  - 400 cautious/valid claims with zero false positives.
- Existing text-guard adversarial corpus: PASS.
- Existing text-guard fuzz: PASS.
- Snapshot + compatibility transport: PASS.
- Blockchain mock backtest: PASS.
- DEV History regressions/fuzz: PASS.
- API/security/analysis/live/execution regressions: PASS.
- Isolated strict TypeScript for `ai-report-guard.ts + ai-claim-validator.ts`: PASS.

## Remaining limitation

A valid evidence key plus a passing scalar assertion still does **not** prove arbitrary natural-language entailment. For example, three individually correct facts may not logically justify a broad strategic conclusion. The system therefore keeps both layers:

1. text semantic guard;
2. evidence-aware claim validator.

A future step could replace some free-form claims with domain-specific typed predicates / decision rules, but that should be introduced only where the semantics are sufficiently deterministic.
