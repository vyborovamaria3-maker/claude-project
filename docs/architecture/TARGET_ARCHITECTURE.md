# Target architecture — current decision

The previous document described an implemented X Collector runtime shape and is not the target architecture for the whole monorepo. It is superseded as a system-wide target by:

- [ARCHITECTURE_TARGET_20261101.md](ARCHITECTURE_TARGET_20261101.md) — approved target boundaries and Solana-only network policy.
- [ARCHITECTURE_AS_IS_20261101.md](ARCHITECTURE_AS_IS_20261101.md) — source-verified current state and legacy gaps.

Core decisions:
1. Solana is the only supported blockchain network in the target.
2. X and TG remain independent social source applications.
3. Blockchain Collector is currently a logical module inside Solana Launcher, not an independent deployable service.
4. Node Intelligence is the cross-source evidence/analytics core.
5. Python Intelligence is a separate document/provider processing runtime.
6. Source data ownership and migration histories remain independent.
7. Outbox delivery is at-least-once; destination commit precedes source ACK.
8. No live deployment or production readiness is inferred from this target document.

Do not implement the old X-only target text as a new service topology. Use the two 2026-11-01 architecture documents above.
