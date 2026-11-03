# Current architecture — source-verified baseline and dated updates

**The old 2026-10-12 baseline below is historical and is not the whole-repository architecture.** It was scoped mainly to X Collector and must not be used as the source of truth for all products.

The source-audit snapshot and target design are preserved as dated artifacts:

- [ARCHITECTURE_AS_IS_20261101.md](ARCHITECTURE_AS_IS_20261101.md) — source audit performed at exact repository HEAD `6273d9fb9f2f987c4ee7932cea0e10f77129f7d9`. It is a dated baseline, not proof of current live deployment.
- [ARCHITECTURE_TARGET_20261101.md](ARCHITECTURE_TARGET_20261101.md) — target architecture, Solana-only.

Subsequent repository/runtime and release-gate changes are recorded in [RELEASE_GATE_REVIEW_20261103.md](RELEASE_GATE_REVIEW_20261103.md), including the later Node 22 workflow alignment and exact-head CI snapshot. Use that review together with the current PR/check pages rather than silently treating the 2026-11-01 audit SHA as the latest code.

Status vocabulary:
- source implementation is not proof of deployment;
- Compose configuration is not proof that a service is running;
- CI fixtures are not live production evidence;
- production DBs, credentials, off-host restore and RPO/RTO remain NOT VERIFIED unless a separate operator record says otherwise.

The previous 2026-10-12 baseline is retained in Git history. Do not copy its runtime assumptions into new documentation without rechecking the current manifests, lockfiles and Compose definitions.
