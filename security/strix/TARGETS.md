# Strix Audit Targets

Baseline reference: `main` at audit start was `f3bc357eb71a054ed8da6052db47be39537672e1`.

## Source targets

| ID | Path | Primary concerns |
|---|---|---|
| T0 | `./` | architecture, cross-component trust boundaries, CI/CD, secrets, supply chain |
| T1 | `./solana-launcher` | Next.js routes, wallet/transaction builders, X/Telegram UI, SSRF, XSS, proxy trust |
| T2 | `./solana-launcher/backend` | FastAPI auth, JWT, Telegram auth, subscriptions, DB, queues, rate limiting |
| T3 | `./admin-site` | admin authentication/session, DB explorer, exports, XSS/CSV injection, Docker |
| T4 | `./memecoin-intelligence` | Fastify API, RBAC/API keys, Redis/BullMQ, PostgreSQL, Qwen integration |

## Ordered audit passes

1. `BASELINE` — attack surface and high-confidence source-aware scan.
2. `AUTHN` — password/JWT/Telegram/API-key/session review.
3. `AUTHZ` — IDOR/BOLA/role escalation/object ownership.
4. `INJECTION` — SQL/command/template/XSS/path/deserialization/prototype pollution.
5. `SSRF` — outbound fetch/RPC/webhook/model-provider URL boundaries.
6. `BUSINESS_LOGIC` — subscriptions, demo access, payment confirmation, transaction builders, queues.
7. `RACE_REPLAY` — payment completion, duplicate signatures, order state, jobs, Redis state.
8. `TELEGRAM_X_PRIVACY` — public/private source boundaries and data leakage.
9. `AI_LLM` — prompt injection, untrusted content, model endpoint authentication, resource exhaustion.
10. `SCA_SUPPLY_CHAIN` — dependencies, lockfiles, Docker bases, Actions, install scripts.
11. `INFRA` — Nginx, Compose, exposed ports, container privileges, secret handling.
12. `STAGING_GREYBOX` — source + staging only; disabled until a staging URL and test accounts are explicitly supplied.
13. `BLACKBOX` — staging-only independent scan after white/grey-box passes.
14. `RETEST` — only confirmed findings after isolated fixes.

## Production policy

Production is not a default target. A production URL/IP must never be inserted into the automated workflow without a separate explicit change and review.

## Scan sizing

- `quick`: PR/diff or narrow hypothesis only.
- `standard`: default for component scans.
- Avoid monorepo `deep` runs until component standard scans are stable and findings are persisted.

## Required output

Every pass must preserve `strix_runs/**` as an artifact even when Strix exits non-zero because vulnerabilities were found.