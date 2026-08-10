# Strix Profile 01 — Baseline Source Audit

Follow `security/strix/ROE_SOURCE_ONLY.md` strictly.

Build an attack-surface map before reporting vulnerabilities.

## Phase A — architecture and trust boundaries

Identify:

- public HTTP routes and API handlers
- authentication entrypoints
- authorization middleware/dependencies
- admin-only routes
- Telegram Mini App and MTProto boundaries
- X/Twitter collectors and browser-session paths
- Solana RPC/payment/transaction flows
- PostgreSQL/SQLite/Redis/RabbitMQ/BullMQ access
- file import/export paths
- outbound HTTP clients and configurable base URLs
- queue workers/background tasks
- LLM/Qwen input and output paths
- Docker/Nginx/GitHub Actions production boundaries

Produce a concise data-flow/trust-boundary map.

## Phase B — source security review

Hunt for reachable issues in these classes:

- broken access control / IDOR
- auth bypass, JWT/session mistakes, default credentials
- SQL/NoSQL/command/template injection
- SSRF/XXE/path traversal/deserialization
- XSS/prototype pollution/unsafe HTML
- CSRF where cookie-based auth is used
- race/replay/idempotency failures
- resource exhaustion / queue abuse / missing limits
- sensitive data in logs, URLs, responses, caches or client storage
- insecure cryptography/randomness
- unsafe file parsing/imports
- container/ingress misconfiguration
- CI/CD/supply-chain weaknesses
- LLM prompt injection with an actual downstream impact

## Phase C — variant analysis

For every validated pattern, search the whole repository for variants before finalizing the report.

## Required output

Separate results into:

1. CONFIRMED
2. NEEDS_PRODUCTION_VERIFICATION
3. HARDENING
4. REJECTED_FALSE_POSITIVES

Do not auto-fix anything.
