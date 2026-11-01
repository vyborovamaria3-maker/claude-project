# Current architecture — source-verified snapshot

**The old 2026-10-12 baseline below is historical and is not the current whole-repository architecture.** It was scoped mainly to X Collector and must not be used as the source of truth for all products.

Current source-verified inventory, exact runtime versions, deployment boundaries, database ownership, CI evidence and open gaps are maintained in:

- [ARCHITECTURE_AS_IS_20261101.md](ARCHITECTURE_AS_IS_20261101.md) — current As-Is audit at HEAD `6273d9fb9f2f987c4ee7932cea0e10f77129f7d9`.
- [ARCHITECTURE_TARGET_20261101.md](ARCHITECTURE_TARGET_20261101.md) — target architecture, Solana-only.

Status vocabulary:
- source implementation is not proof of deployment;
- Compose configuration is not proof that a service is running;
- CI fixtures are not live production evidence;
- production DBs, credentials, off-host restore and RPO/RTO remain NOT VERIFIED unless a separate operator record says otherwise.

The previous 2026-10-12 baseline is retained in Git history. Do not copy its runtime assumptions into new documentation without rechecking the current manifests, lockfiles and Compose definitions.
