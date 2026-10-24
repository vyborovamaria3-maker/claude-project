# Platform readiness execution plan — 2026-10-24

**Baseline:** `main` commit `8f79ce9284e42e35de78e0e983c6ba460677ef58` (observed 2026-10-24). This is a **prioritized execution backlog**, not an assertion that tests/production changes have occurred. The 7/21/30-day windows are planning targets, contingent on operator access, review and evidence. GitHub Issues are the source of ownership and completion truth.

## Success definition

The first release candidate is a **proposed verified-mint Token Intelligence view** — not a trading bot or a validated alpha service. One mint can be queried through a safe authenticated read path; each X, TG and chain event has independent provenance, identity evidence, known-at/occurred-at cutoffs, retractions and explicit unknowns. No false claims about full history, wallet ownership, signals or PnL.

## P0 (target days 1–7): protect, recover and verify

| Issue | Workstream | Required proof | Blocked by |
| --- | --- | --- | --- |
| [#170](https://github.com/vyborovamaria3-maker/claude-project/issues/170) | Protect `main` | Admin-set effective branch rules, enforced required checks, reviewed bypass path | GitHub admin/operator |
| [#171](https://github.com/vyborovamaria3-maker/claude-project/issues/171) | Security Gates | Reproduce and fix latest-head product audits on actual merge candidate; green job links | CI/job ownership |
| [#172](https://github.com/vyborovamaria3-maker/claude-project/issues/172) | Physical DB inventory + backup/restore | DB/schema/owner registry, backup and isolated restore evidence; SSH trust verified | Operator-approved test infra |
| [#173](https://github.com/vyborovamaria3-maker/claude-project/issues/173) | Verified canonical token joins + retractions | Disposable PG/SQLite X/TG/chain assertions, replay and invalidation safety; real sources separately gated | Identity resolver/PR #165, DB fixtures |
| [#174](https://github.com/vyborovamaria3-maker/claude-project/issues/174) | Delivery supervision/recovery | Durable ACK-after-commit, restart/replay/lease/DLQ, lag metrics; bounded worker | Independent source/destination test DB |
| [#175](https://github.com/vyborovamaria3-maker/claude-project/issues/175) | Live verification | Separate controlled X/TG/RPC/operator-approved runs with sanitized evidence; unrun remains NOT RUN | Operator accounts/permissions/budget, P0 isolated tests |

**Exit P0 only when:** protections and required security checks are verified; backup **restores** succeed; correct token provenance/retractions and worker failure handling are proved on isolated stores; real external validation is explicitly recorded or release scope excludes the unverified feature. “CI green” does not satisfy the live gate.

## P1 (target days 8–21): simplify integration and deliver user workflow

| Issue | Workstream | Required proof | Dependencies |
| --- | --- | --- | --- |
| [#176](https://github.com/vyborovamaria3-maker/claude-project/issues/176) | Reconcile #165/#166/#167 | One reviewed API/auth/data contract and intentional merge order, green latest-head checks | P0 security and contract invariants |
| [#177](https://github.com/vyborovamaria3-maker/claude-project/issues/177) | Token Intelligence MVP | Search by verified mint → source-qualified evidence/chronology/coverage/unknowns, auth and UX smoke | P0 identity, P1 API design |
| [#178](https://github.com/vyborovamaria3-maker/claude-project/issues/178) | Observability and runbooks | Source lag, worker heartbeat, DLQ, canary alerts, actual failover drill | P0 runtime/backup |
| Documentation | README, PR inventory, contracts, gaps and test register | Links valid; current facts separated from historical baselines | Keep updated at each verified PR/CI event |

**Exit P1 only when:** one user journey is reproducible, read access is authorized, operational freshness is visible and the release has an auditable rollback path. Do not broaden to all codebases by default.

## P2 (target days 22–30): validation beyond code

| Issue | Workstream | Required proof | Dependencies |
| --- | --- | --- | --- |
| [#179](https://github.com/vyborovamaria3-maker/claude-project/issues/179) | Historical outcomes/model evaluation | Holdout, no-look-ahead, uncertainty, source coverage, NULL for unsupported PnL | Traceable full/partial evidence |
| [#180](https://github.com/vyborovamaria3-maker/claude-project/issues/180) | Pilot and focus decision | Measured user utility/retention/cost/willingness to pay; go/no-go | Working bounded MVP |

## Non-negotiable safety and truthfulness gates

- **No unauthorized X post/like/follow, Telegram session login, paid Solana RPC, production DB mutation or secret transmission.** These depend on an external operator and cannot be completed merely from a GitHub code-review connection.
- **No secrets in evidence** (no cookies, auth tokens, sessions, SQL connection strings, private keys). Use names of logical destinations only.
- No re-use of historic `passed` as latest-head CI proof. Mark `NOT RUN` when unexecuted and `BLOCKED` if a prerequisite is missing.
- Do not merge open stacked AI API PRs blindly; #166 currently targets the #165 feature branch and #167 also extends analytics/AI surfaces.
- Avoid unauthorized changes to X/TG/chain production storage, historical migration manifests, installed runtime flags or the subscription product.
- Code writing and merging documents does not constitute satisfying any operational gate.

## Evidence updates

Record each run in [LIVE_TESTS.md](LIVE_TESTS.md) with UTC time, full SHA, command, environment, independent source DB identifier (nonsecret), expected vs actual assertion, sanitized log URL and owner/reviewer. Update [KNOWN_GAPS.md](KNOWN_GAPS.md) when evidence changes a blocker. Refresh [PR_STATUS.md](PR_STATUS.md) from GitHub current state before a release. Use [DATA_CONTRACTS.md](DATA_CONTRACTS.md) as the authoritative store/identity inventory and [Architecture decisions](ARCHITECTURE_DECISIONS/) for intentional design choices.
