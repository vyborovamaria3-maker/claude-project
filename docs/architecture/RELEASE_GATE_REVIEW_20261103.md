# Release gate review — 2026-11-03

Repository-only review on existing branch `integration/recovery-209-211-20261031`
(#212). No merge, deployment, production access, real database operation or
repository administration. This dated snapshot supplements the historical
`PR_STATUS.md` and the 2026-11-01 As-Is/Target documents.

## PR observations

Main: `f4dc5ef3aad400f64fc300f30542085e10aae4c1`. All six PRs were mergeable
against their bases at initial inspection. Mergeability is not approval.

| PR | Observed head | State | Exact-head check snapshot |
| --- | --- | --- | --- |
| #205 | `f6081d97d1f918b60be3e6799809535b28e9b83f` | Open | 5 success, 1 skipped |
| #206 | `a329640dd694ce2b7f6928b61d0fafd4a079b93a` | Open | 30 success, 1 skipped |
| #209 | `aa0cb5006314e9eac48d3e65463d5e70da7e3c8c` | Closed, unmerged | 28 success, 1 skipped |
| #211 | `ba68c47c7469ac84a5a515ca94a7b1cda007e9ca` | Closed, unmerged | 23 success, 1 skipped |
| #214 | `f1f5bc61b968641c617db078d41a7bc7e1e47a7e` | Closed, unmerged | 28 success, 1 failure, 1 skipped |
| #212 | `b87c3c5da4ed7ac1d64e330561b18db795068236` | Open, Draft | 42 queued, 1 skipped at approximately 12:33 UTC; incomplete |

#214 failed the [Synthetic PG16, PG17 and SQLite WAL full restore job](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41226104655/job/124610463513).
#212 is the active combined recovery implementation. Its head moved from
`508fec1c` through `7d15192f` to `b87c3c5d` during review. Older cancelled/green
runs do not validate newer commits. Refresh CI after every push.
Initially GitHub compare reported #205 67 ahead/0 behind, #206 27/0 and
#212 221/0; these counts are dated observations. The seven existing #212
inline threads were resolved, which does not approve subsequent commits.

Changed-path overlaps with #212:

- #205: current architecture, data contracts, gaps and live-test records;
  preserve its separate baseline refresh and reconcile status prose.
- #206: `.github/workflows/tg-collector.yml`, `docs/architecture/DATA_CONTRACTS.md`.
- #204: predeploy workflow, `admin-site/app/main_admin.py`, frontend package manifest.
- #203/#195: frontend package manifest; reconcile scripts/dependencies explicitly.
- #208: both Telegram Mini App README files.
- #209/#211/#214: intentionally overlapping superseded recovery implementations.
- #202/#210/#213: no direct changed-path overlap in the returned lists.

Do not integrate obsolete recovery PRs alongside #212. File overlap alone
neither proves nor excludes semantic conflicts. No cross-PR merge was performed.

## Compatibility and dependency findings

The frontend manifest requires Node >=22 and production uses Node 22, but
Full Backtest Audit, Social Analysis UI CI, the Telegram Intelligence v1.9
frontend job and standalone development `Dockerfile.frontend` selected Node 20.
This change aligns these four selections with Node 22. No application
dependency or lockfile changed. Node 20 is EOL; Node 22 remains LTS per the
[official schedule](https://github.com/nodejs/Release#release-schedule).
Independent legacy/Qwen/hygiene jobs still select Node 20 and need separate
validation rather than an untested repository-wide replacement.

Production-only lockfile audits (`npm audit --package-lock-only --omit=dev`):

| Workspace | Low | Moderate | High | Critical |
| --- | --- | --- | --- | --- |
| solana-launcher | 53 | 20 | 0 | 0 |
| x-collector | 0 | 0 | 0 | 0 |
| tg-collector | 0 | 0 | 0 | 0 |

Frontend audit is **not clean**. Moderate/low findings remain dependency debt;
no blanket audit fix, major upgrade or weakened policy was used. This audit
excludes development dependencies and other Python/Node workspaces.

## Architecture, E2E and recovery boundaries

Source/configuration review distinguishes Blockchain `trade.db`, Python
Intelligence SQLite and Node Intelligence PostgreSQL. The central bundle
contains product/Admin PostgreSQL dumps, password-free role globals/catalog
fingerprints and both SQLite snapshots. SQLite uses online backup APIs,
source/integrity checks and private temporary files. Manifest completeness
and special-entry rejection precede isolated restore; publication requires
successful verification. Data-only PG restore and owner/ACL fingerprint
restore are separate gates. These mechanisms do not establish actual RPO/RTO.

Producer integration invokes real bounded X/TG verifiers/outbox writers,
Blockchain revision writer and destination consumer against fixtures/mocked
RPC. Retractions and ACK-loss replay are covered in code, not live collection,
finality, sustained load or trading validity. Exact-head CI is still required.
The Node Intelligence PostgreSQL production backup schedule/owner remains
unverified. Product/Admin bootstrap-role use remains a privilege concern
until actual roles and existing-volume ownership are audited by an operator.

Local validation: contracts strict typecheck and **22/22 tests** passed on
Node **22.23.4**; package check also passed on host Node 24.18.0. Repository
hygiene passed over 4,084 tracked files. Bash syntax passed for central
backup/restore, off-host wrapper and PostgreSQL/recovery test scripts;
`git diff --check` passed. No full frontend/image build was run locally.
Docker Linux engine is unavailable. SSH pin negative tests stopped because
Git Bash/Windows could not set fixture `.ssh` permissions: unpassed, not waived.
Release trigger/SHA policy regressions passed **11/11** on Node 22 after
selecting Git Bash explicitly in PATH. The initial attempt used the unavailable
WSL Bash and failed four cases; that environment issue was corrected for the
successful rerun. These tests use temporary local Git repositories only.

## Decision

**HOLD.** API reconfirmed `main protected:false`, no required checks and
`rulesets: []`; #170/#172 remain open. Complete CI on the final #212 head,
review backup behavior and reconcile overlapping PRs. A repository admin
must separately evidence effective protection and blocked failing merges
(#170). An approved operator must inventory physical stores/roles, verify
encrypted off-host backup, rehearse isolated actual-data/app recovery and
record measured RPO/RTO, ownership and sign-off (#172). None of those live
operations is authorized or performed by this review.

## Current exact-head continuation — 2026-11-03 (supersedes interim #212 snapshot above)

A fresh read-only refresh after the 12:57 UTC interim observation gives:

| PR | Exact head | State | Exact-head CI | Compare to main |
| --- | --- | --- | --- | --- |
| #205 | `f6081d97d1f918b60be3e6799809535b28e9b83f` | Open | 4 SUCCESS, 1 SKIPPED | 67 ahead, 0 behind |
| #206 | `a329640dd694ce2b7f6928b61d0fafd4a079b93a` | Open | 18 SUCCESS, 1 SKIPPED | 27 ahead, 0 behind |
| #209 | `aa0cb5006314e9eac48d3e65463d5e70da7e3c8c` | Closed, unmerged | 15 SUCCESS, 1 SKIPPED | 0 behind at its base |
| #211 | `ba68c47c7469ac84a5a515ca94a7b1cda007e9ca` | Closed, unmerged | 11 SUCCESS, 1 SKIPPED | 0 behind at its base |
| #214 | `f1f5bc61b968641c617db078d41a7bc7e1e47a7e` | Closed, unmerged | 15 SUCCESS, 1 FAILURE, 1 SKIPPED | 0 behind at its base |
| #212 | `2c882f055cc2caa00bba336d4f47d4cb355bac84` | Open, Draft | **27 SUCCESS, 1 SKIPPED, 0 FAILURE, 0 running** | 232 ahead, 0 behind |

All six branches compare against main SHA
`f4dc5ef3aad400f64fc300f30542085e10aae4c1`. No main commit was added by
this work. PR #212 has 90 changed files (+6,314 / -824); its large review
surface must be independently reviewed in full, not inferred from the green
checks.

### Exact-head evidence for #212

- [ARCH-02 SSH pins and restore rehearsal](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41639700254) — **3/3 jobs SUCCESS**, including synthetic PG16/PG17 role/ACL restore, SQLite WAL restore, positive operator-wrapper evidence JSON, corrupt-backup rejection and port-aware SSH pin regressions.
- [POTAPoff predeploy gate](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41639700102) — **5/5 jobs SUCCESS**.
- [Admin PostgreSQL 17 restricted-role rehearsal](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41639700283) — SUCCESS.
- [Repository hygiene](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41639700345) — SUCCESS.
- [Security Gates](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41639700218) — SUCCESS.
- [Full Backtest Audit](https://github.com/vyborovamaria3-maker/claude-project/actions/runs/41639700296) — SUCCESS.
- One workflow, Security Lock Refresh, is SKIPPED. No workflow on this exact SHA is failed, queued or in progress.

### Review and overlap state

- #212: seven inline review threads are resolved. Its two recorded review submissions
  are both `COMMENTED` by the PR author; **no independent APPROVED review exists**.
- #206: four inline threads are resolved, but the five recorded reviews are
  `COMMENTED` by the PR author only; no independent approval.
- #205: no review submission or inline review thread is recorded.
- Changed-file overlap: #205 ↔ #212 = 3 paths
  (`CURRENT_ARCHITECTURE.md`, `KNOWN_GAPS.md`, `LIVE_TESTS.md`);
  #206 ↔ #212 = 3 paths (`tg-collector.yml`, `DATA_CONTRACTS.md`,
  `tg-collector/README.md`); #205 ↔ #206 = 1 path
  (`intelligence/README.md`). Preserve both sides deliberately when merge
  order is eventually approved. #209/#211 are closed unmerged and #212 is the
  current combined recovery candidate.

### Remaining release decision

Read-only GitHub API still reports `main.protected=false` and
`/rulesets=[]`. The integration cannot administer branch protection
(the protection endpoint returns 403). #170 remains open for repository-admin
enforcement and a demonstrated blocked merge. #172 remains open for actual
physical database/role inventory, independently encrypted off-host backup,
isolated real-backup/application restore, measured RPO/RTO and operator
sign-off. No actual off-host backup, production credentials, live database,
migration, role change or deployment was accessed or executed.

**Decision remains HOLD.** Green exact-head CI closes the code/CI validation
gate for this snapshot only. It does not supply independent review, admin
governance, or live recovery evidence. Keep #212 Draft and do not merge or
deploy until all three are independently satisfied.
