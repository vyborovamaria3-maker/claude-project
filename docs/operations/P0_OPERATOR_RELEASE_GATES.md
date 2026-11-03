# P0 operator gates — protected main and off-host recovery

Status refreshed **2026-11-03** against Draft PR #212 code HEAD `0fa86e850a626b91ec79bf20ee00e319b399d0b2`. This is an
operator runbook, **not** evidence of real production validation or
authorization to deploy/change credentials. Tracking: #170 and #172.

## Gate A — protect main (#170; repository administrator only)

Observed via GitHub read-only API on 2026-11-03:

- `GET /branches/main`: `protected: false` at commit
  `f4dc5ef3aad400f64fc300f30542085e10aae4c1`.
- `GET /rulesets`: empty list `[]`.
- The connected GitHub integration cannot read/edit branch protection
  (`/branches/main/protection` returns `403 Resource not accessible by integration`).
- No bypass, force update, merge, or attempted admin change was performed.

**Administrator action, in repository settings:** open Settings → Rules →
Rulesets (or Branches, according to the available UI); create an *active*
branch ruleset targeting **exactly `main`**. Require pull requests and at least
one independent approval, dismissal of stale approvals after new commits,
resolved conversations, no force-push/deletion and passing CI before merging.
Restrict bypass to named emergency administrators with recorded incident,
reviewer approval and postmortem. Ensure applicable rules cannot be bypassed
by ordinary repository writers.

**Status-check trap:** the full predeploy and PG17 role workflows have
`pull_request.paths` filters. Requiring those checks for *every* PR causes
docs-only changes to wait forever for missing checks. Do not force path-gated
checks into a universal ruleset. Start with always-triggered
`Repository hygiene / hygiene` and assess a single always-triggered,
fail-closed release-gate aggregator (or carefully designed per-path rules)
before requiring any other check. Confirm the *exact check run names* in
GitHub branch rules and ensure a docs-only PR, backend PR and Admin/backup PR
can each satisfy required checks appropriately. Never select a permanently
skipped check as required.

**Required administrator evidence (not collected):** ruleset ID/URL,
enforcement=active, exact target, bypass principals, required context list,
one deliberately failing disposable PR prevented from merging, an approved
green PR flow, date/reviewer, and a fresh API check confirming effective
protection. A successful PR CI alone does **not** protect main.

## Gate B — actual off-host, encrypted backup restore (#172)

**Do not use production hosts, mounted production volumes, real credentials,
or source DBs as a restore destination.** No public GitHub Actions job is
permitted to download decrypted real backups. The operator must own both the
isolated restoration host and access approval. The GitHub connector cannot
fetch a private real backup or certify encryption.

### Preflight checklist (operator sign-off)

1. Approve the change/ticket and name the primary operator and independent
   reviewer. Record the exact *reviewed* PR commit, code version, backup
   completion/consistency timestamp, retention policy, incident/recovery
   reference time and expected **independently stored** SHA256 of
   `SHA256SUMS`. A manifest hash computed solely from the delivered plaintext
   copy proves no independent chain of custody.
2. Verify source was encrypted and durably stored on a separate host/storage
   account (access controls, encryption method, key custodian, immutable
   retention, independent digest). Decrypt into a private **staging copy on an
   isolated machine**, never into the checkout/CI runner/repo. No secrets or
   original backup files are committed to Git.
3. Identify the restored data's provenance and physical instance, major
   PostgreSQL version, original backup consistency timestamp and estimated
   size. `trade.db` can be very large; check *separately* free space on the
   encrypted store, decrypted staging, `TMPDIR`, and Docker root. Allow for
   two disposable PostgreSQL clusters and multiple SQLite copies; do not
   assume a small compressed dump equals small restored storage. Verify CPU,
   Docker disk quota, memory and time windows **before** execution.
4. Verify no live volume mount, VPN route, production credentials or shared
   Docker socket/containers can be affected. The underlying verifier uses
   `docker run --network none`, no published ports and temporary containers;
   this does not in itself guarantee spare host resources.
5. Make the offline restore copy accessible by an operator-only login; both
   the decrypted backup directory and evidence directory must be owned by the
   current operator and have no group/world permission bits (mode `0700`).
   The wrapper rejects weaker permissions. The selected Docker endpoint must
   be local (`unix://` or `npipe://`); remote TCP/SSH contexts are rejected.
   `umask 077` protects newly created files but does not repair permissions on
   existing directories. Treat a decrypted backup as secret material and
   securely dispose of it following policy.

### Command: local-only verification (operator runs; not run by CI)

Only after independent approval and capacity checks, from the **clean exact reviewed Git checkout** with adjacent
`solana-launcher/scripts/postgres-role-restoration-fingerprint.sql`.
The wrapper now requires that `--code-sha` equal this checkout's actual `HEAD` and that its tracked wrapper, verifier and fingerprint SQL have **no local modifications**. It fails closed for an absent Git checkout, a mismatched SHA, or changed/untracked verifier code:

```bash
mkdir -p -m 0700 /isolated/private-recovery-evidence
bash solana-launcher/scripts/run-offhost-recovery-evidence.sh \
  --backup-dir /isolated/decrypted-recovery-copy/2026-11-01-backup \
  --expected-manifest-sha256 '<64-hex-from-independent-offhost-register>' \
  --evidence-dir /isolated/private-recovery-evidence \
  --code-sha '<full-reviewed-40-hex-commit-sha>' \
  --ticket-id '<approved-nonsecret-ticket-id>' \
  --confirm-isolated-offhost
```

Example paths and placeholders are NOT real locations or hashes. Do not pass
passwords or encryption keys on the command line. The wrapper validates an
independent backup manifest digest *before* invoking the existing
`verify-backup-restore.sh`, which checks the complete set, SQLite integrity,
PG16/17 schema/owner/ACL restore and negative safety invariants using
disposable resources. Detailed logs and JSON evidence remain in the private
directory. The JSON exposes only a nonsecret ticket, reviewed SHA, aggregate size,
manifest hash, verification timestamps/duration, local Docker endpoint kind,
private-log basename, explicit `RPO/RTO=NOT_MEASURED`, encryption provenance
status, source-write flag, production-isolation attestation status and
`approval_for_role_cutover=false` — **not** database rows, connection strings,
hostnames or backup file paths. Do not upload raw logs.

**This verifies restore integrity, not total recoverability.**
A completed tool run reports `verification_elapsed_seconds`, **not RTO**;
the end-to-end RTO clock must start at the operator-declared outage and stop
when restored services pass independently verified readiness and user paths.
RPO must be calculated from the latest confirmed *application transaction
timestamp/LSN* actually present after restoration versus the declared
incident recovery point, not from file mtime or the backup folder name.
The wrapper records both `rpo_status` and `rto_status` as
`NOT_MEASURED` until separately evidenced.

### Human-reviewed acceptance and rollback

- With credentials held only by the operator (separate from backups), start
  the restored service stack **without any path to production**. Verify
  representative transaction IDs, critical counts/row invariants,
  non-superuser runtime/backup login, migration/version ledger, worker
  restart/replay, Admin API readiness, authorization and audit immutability.
- Compare observed data point to declared incident time; document **actual**
  RPO and **actual** end-to-end RTO with UTC timestamps and reviewer sign-off.
  Record externally supplied encryption and off-host durability evidence.
- Review and sign the object-by-object forward/reverse PostgreSQL ownership
  map. Do not use blanket `REASSIGN OWNED`, overwrite live databases or
  demote the old bootstrap role during this test.
- Mark #172 complete only after original and replayed backup hashes,
  verified restore, operational app check, measured targets and documented
  approval. If any gate fails, block cutover, retain existing backups,
  roll back test-only isolated resources and open a corrective PR.

## Source-to-storage inventory: **code-level only, not observed live**

| Code source | Intended storage and ownership boundary | Actual physical instance / owner / data size |
| --- | --- | --- |
| `x-collector/` | Independent X PostgreSQL; native ordered migrations | UNKNOWN — operator inventory required |
| `tg-collector/` | Independent TG PostgreSQL + native migration ledger | UNKNOWN — operator inventory required |
| `solana-launcher/` | Product PostgreSQL 16 and independent blockchain `data/trade.db` SQLite/WAL | UNKNOWN — code Compose is not proof of deployment |
| `intelligence/src/` | Separate Node Intelligence PostgreSQL destination | UNKNOWN — not interchangeable with Python Intelligence |
| `intelligence/storage/` | Python Intelligence PostgreSQL or separate SQLite backend | UNKNOWN |
| `memecoin-intelligence/` | Independent Memecoin PostgreSQL + Redis | UNKNOWN |
| `admin-site/` | Admin PostgreSQL 17 for configured state; optional SQLite and intelligence read model | UNKNOWN — runtime DSN/config not inspected |
| `solana-subscription-service/`, `telegram-miniapp/` | Independent subscription/application state | UNKNOWN — operator discovery required |

Redis and disposable CI databases are **not** counted as physical PostgreSQL
application instances. No definitive live database count can be inferred from
source files. See `docs/architecture/DATA_CONTRACTS.md` for each source's
distinct identity and schema constraints.

## Current exact-head CI evidence versus outstanding P0 — 2026-11-03

Current code-bearing Draft PR #212 HEAD:
`0fa86e850a626b91ec79bf20ee00e319b399d0b2`. GitHub Actions reports
**27 SUCCESS, 1 SKIPPED, 0 FAILURE, 0 QUEUED, 0 IN PROGRESS** on this exact
SHA. The skipped workflow is `Security Lock Refresh`; it is not counted as a
successful check.

| Gate | Exact-head result | Evidence | Remaining limitation |
| --- | --- | --- | --- |
| Restricted Admin PostgreSQL 17 startup/permissions and real app smoke | **SUCCESS** | [run 41664963144](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664963144) | Disposable PG17, not production Admin credentials/volume |
| Product/Admin PG16/17 owner/ACL and SQLite WAL restore | **SUCCESS — 3/3 jobs** | [run 41664963069](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664963069) | Synthetic data and disposable clusters; not a real off-host archive |
| Restore semantic contract and sequence regression | **SUCCESS** | [ARCH-02 run 41664963069](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664963069) | CI sentinels and schema/sequence invariants; no source-vs-live production reconciliation |
| X/TG/Blockchain → Intelligence integration and Intelligence PG archive restore | **SUCCESS** | [run 41664963149](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664963149) | Mocked RPC and isolated PostgreSQL, not live provider/source validation |
| Operator evidence wrapper positive/negative paths | **SUCCESS** | [ARCH-02 run 41664963069](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664963069) | Synthetic fixture only; no actual encrypted backup fetched |
| Security Gates | **SUCCESS** | [run 41664963079](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664963079) | CI only |
| Full Backtest Audit | **SUCCESS** | [run 41664962949](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664962949) | Audit fixtures/config checks, not production trading validation |
| POTAPoff predeploy | **SUCCESS — 5/5 jobs** | [run 41664962920](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664962920) | Predeploy CI/build, not a production deployment |
| Repository hygiene | **SUCCESS** | [run 41664962957](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664962957) | CI only |
| Solana Subscription Web Quality | **SUCCESS** | [run 41664962964](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41664962964) | Typecheck/build, not production deployment |
| Effective protection of GitHub `main` | **BLOCKED** | 2026-11-03 read-only API: `protected:false`; `/rulesets=[]` | Repository administrator must configure and prove enforcement, issue #170 |
| Independent PR approval | **NOT RECEIVED** | Seven inline threads resolved by PR author; recorded reviews are COMMENTED only | Independent human review of the complete 91-file diff remains required |
| Real encrypted off-host backup and full restore | **NOT RUN / BLOCKED** | No approved private backup or isolated operator host was provided/accessed | Independent manifest digest, actual-volume restore, application smoke, measured RPO/RTO and operator sign-off, issue #172 |

PR #212 remains **OPEN / DRAFT / UNMERGED** with 91 changed files and 239
commits ahead of `main` (0 behind). PRs #209 and #211 are **CLOSED,
UNMERGED**; #212 is the active combined recovery candidate. PRs #205 and #206
remain open and overlap with #212 on 3 paths each; reconcile deliberately
before any merge.

The **real off-host restore, branch protection and independent approval remain
NOT VERIFIED**. Passing synthetic CI does not waive these P0 gates or authorize
a merge, credential/role cutover or deployment.



## 2026-11-04 follow-up — current PR #212 candidate

At the start of this follow-up, PR #212 was at 2b09d722fd4b7c7fb25a104dffb5fb850af79d30. Its exact-head GitHub check-runs were 45 SUCCESS, 1 SKIPPED, 0 FAILURE. The skipped refresh-lockfiles job was branch-condition skipped, not a pass. All 7 inline review threads were RESOLVED; recorded reviewer submissions remained COMMENTED and no independent APPROVED review was present.

The repository rulesets endpoint returned an empty list. The branch-protection endpoint returned 403 Resource not accessible by integration, so no branch-protection setting was changed and this document does not claim that main is protected or unprotected. Issue #170 remains an administrator-owned gate.

Subsequent commits on the PR #212 branch add:
- complete normalized inbox payload fingerprints and an additive migration 017;
- fail-closed readiness checks when the fingerprint column is missing;
- a bounded legacy fingerprint backfill with source read-only transactions, dry-run default, explicit execute opt-in and destination compare-and-set;
- a safe ordinary Compose down command that preserves named volumes, with volume deletion moved behind an explicit confirmation variable.

CI must be rerun on the resulting exact commit before these changes are considered verified. No production database, source outbox, real backup, credentials, branch protection setting, live collector or deployment was accessed or changed.
