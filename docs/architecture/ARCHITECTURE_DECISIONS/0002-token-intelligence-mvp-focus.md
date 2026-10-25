# ADR-0002 — Focus on a verified-mint Token Intelligence MVP

- **Date:** 2026-10-24
- **Status:** Proposed (product hypothesis; not an accepted commercial strategy).
- **Owner:** product/repository maintainer (assignment pending).
- **Related issues:** [#176](https://github.com/vyborovamaria3-maker/claude-project/issues/176), [#177](https://github.com/vyborovamaria3-maker/claude-project/issues/177), [#180](https://github.com/vyborovamaria3-maker/claude-project/issues/180)

## Problem

Many workspaces coexist. They should not be called “14 independent products” without testing deploy and business boundaries. More simultaneously developed APIs increase review and support load. The availability of collectors, feature tables or NLP models does not by itself prove a valuable user-facing product.

## Proposed focus

Test one flow: a user enters a **verified Solana mint** and receives X and TG observations, applicable chain evidence and a time-qualified timeline. Every signal includes its source, known-at time and coverage limits. Missing/out-of-date data must be visible. Backtests/PnL are excluded from the initial value proposition unless separately validated.

Reuse `x-collector`, `tg-collector`, Node `intelligence`, shared contracts/outbox and `solana-launcher` UI as modules; do not assume `memecoin-intelligence`, `solana-subscription-service` or Python Intelligence must be migrated or bundled. Subscription service remains an independent deploy candidate.

## Alternatives considered

- **Solana launcher-first:** viable if users primarily want chain workflow rather than information discovery; assess separately.
- **Subscriptions-first:** narrower deploy scope, but does not prove the cross-source research proposition.
- **Platform-first:** broad capability without a bounded customer promise; defer until real MVP usage validates demand.

## Acceptance and reversal

After a secure pilot, measure task completion, relevant evidence coverage, repeat usage, operating cost and willingness to pay. Accept, revise or reject the proposed focus with dated user evidence. If pilot demand is weak, keep source contracts reusable and reevaluate launcher/subscription focus rather than manufacturing uptake.
