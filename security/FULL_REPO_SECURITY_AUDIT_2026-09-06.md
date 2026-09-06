# Full Repository Security Audit — 2026-09-06

Repository: `vyborovamaria3-maker/claude-project`

Audit type: white-box source/configuration review with deterministic security-pattern checks and manual review of authentication, authorization, payments, webhooks, outbound requests, secrets, infrastructure defaults, MCP integrations and security automation.

This is a **source audit**, not a claim that the deployed system is fully secure. GitHub-hosted Actions were unavailable during this audit and no owner-authorized live DAST target was exercised in this session.

## Executive summary

This pass extended the earlier `vibe-audit` remediation beyond `solana-launcher` to the other applications, services and repository tooling.

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| FSA-001 | Critical/High | JWT-style external credential committed in `pumpfun-chart` source | CURRENT SOURCE FIXED — ROTATION REQUIRED |
| FSA-002 | High | Helius API key could be disclosed by MCP error text through a credential-bearing response URL | FIXED IN SOURCE |
| FSA-003 | High | RSS outbound fetch allowed DNS/private-network and redirect-based SSRF paths | FIXED IN SOURCE |
| FSA-004 | High/Hardening | `memecoin-intelligence` development API/web were host-exposed while development RBAC may be disabled | FIXED IN SOURCE |
| FSA-005 | High | Secret scanner had fail-open placeholder and tracked-artifact coverage gaps | FIXED IN SOURCE |
| FSA-006 | High/Coverage | Repository secret scanning did not trigger for several top-level project areas | FIXED IN SOURCE |
| FSA-007 | High | `solana-subscription-service` development Compose exposed DB/cache/API/web/ngrok and used weak/no service authentication | FIXED IN SOURCE |

Previously known items that remain operationally open:

- provider-side rotation/revocation of historically committed credentials;
- coordinated Git history cleanup after rotation where desired/required;
- the upstream-blocked `bigint-buffer` advisory in the legacy Solana JavaScript dependency chain, with the existing exception expiring `2026-10-01`;
- dependency audits and regression suites must actually execute once a runner/local build environment is available;
- owner-authorized deployed-service reachability/DAST verification remains pending.

## Scope reviewed

Sensitive code/configuration was reviewed across:

- `solana-launcher` — FastAPI auth/subscription/admin/intelligence/task paths and Docker/runtime security;
- `solana-subscription-service` — Express/Prisma auth, cookies, Telegram verification, payment/webhook/on-chain flows, development and production Compose;
- `telegram-miniapp` — legacy backend/bot/frontend identity and subscription/payment paths;
- `memecoin-intelligence` — API access policy/RBAC/configuration, AI controls and Compose;
- `intelligence` — web/RSS/YouTube provider clients and shared URL validation;
- `admin-site` — authentication/session handling, production controls, database/query/export handling;
- `mcp-servers` — Solana/Helius, Pump.fun/database and X integrations;
- `pumpfun-chart` — backend source and credential exposure;
- root scripts, local Strix integration and tracked source artifacts;
- `.github/workflows` and repository security automation;
- prior audit findings and remaining dependency/credential exceptions.

Supporting signature searches found no current indexed hits for direct `dangerouslySetInnerHTML`, direct `innerHTML`, `eval(`, `shell=True`, or `shell: true`. These searches are supporting evidence only, not a substitute for SAST/runtime testing.

## Confirmed findings

### FSA-001 — Critical/High — JWT-style credential committed in `pumpfun-chart`

**Affected:** `pumpfun-chart/backend/candle-aggregator.js`

A JWT-like credential was present literally before the JavaScript file's normal header. Because it entered Git history, deleting the current-tree value alone does not make the credential safe.

**Remediation:**

- removed it from the current source tree;
- JWT-like tokens are covered by the secret scanner and local regression gate;
- provider-side rotation/history requirements are documented without reproducing the value.

**Closure:** identify the issuing provider from trusted records, revoke/rotate the old token, review provider logs and verify the old token no longer authenticates.

Status: **CURRENT SOURCE FIXED — EXTERNAL ROTATION REQUIRED**.

### FSA-002 — High — Helius API key disclosure in MCP errors

**Affected:** `mcp-servers/src/solana-server.ts`

Helius credentials are placed in the request query string. Previous error text included `response.url`, which could copy the credential-bearing URL into MCP/model logs or transcripts. A reflected response body could also repeat it.

**Remediation:**

- error text no longer contains `response.url`;
- configured Helius keys are defensively redacted from response-body details;
- surfaced error detail is bounded.

Status: **FIXED IN SOURCE**.

### FSA-003 — High — RSS SSRF through DNS resolution and redirects

**Affected:**

- `intelligence/security/urls.py`
- `intelligence/providers/rss/client.py`

The prior validator rejected literal localhost/private IP URLs but did not resolve normal hostnames immediately before connecting. Standard-library redirects were also followed without revalidating the destination. A public-looking hostname or public feed redirect could therefore target loopback/private/link-local infrastructure.

**Remediation:**

- outbound hostname is DNS-resolved immediately before the request;
- every resolved address must be globally routable;
- every HTTP redirect target is revalidated with the same outbound policy;
- HTTP/HTTPS-only, no-credentials, response-size and timeout limits remain;
- regression tests cover private resolution rejection and public resolution acceptance.

Residual defense-in-depth: network egress policy is still recommended because application-layer DNS validation cannot formally eliminate every DNS-rebinding/transport race.

Status: **FIXED IN SOURCE / NETWORK EGRESS DEFENSE RECOMMENDED**.

### FSA-004 — High/Hardening — Development intelligence API exposed beyond localhost

**Affected:** `memecoin-intelligence/docker-compose.yml`

Development access policy may intentionally disable RBAC for local compatibility while API/web development ports were published on all host interfaces.

**Remediation:** API `3001` and web `5173` are now host-bound only to `127.0.0.1`; container-to-container networking is unchanged.

Status: **FIXED IN SOURCE**.

### FSA-005 — High — Secret scanner fail-open/artifact gaps

**Affected:** `security/audit/secret-scan.py`

Two confirmed scanner gaps were identified:

1. placeholder text anywhere on a line caused the entire line to be skipped, so a real secret on that same line could evade detection;
2. tracked `.patch/.diff` and ZIP source artifacts were outside current-tree text scanning, creating an opaque copy of source that could retain a secret after the live file was cleaned.

**Remediation:**

- placeholders are evaluated only against the exact regex match;
- `.patch`, `.diff`, SQL/HTML/CSS/XML and other relevant text artifacts are scanned;
- tracked ZIP archives are opened and eligible text entries are scanned;
- per-entry and total uncompressed-size limits fail closed against unsafe/oversized archives;
- unreadable archives/entries are surfaced as findings rather than silently skipped;
- local regression creates a fixture ZIP containing a JWT-like value and verifies detection.

Status: **FIXED IN SOURCE**.

### FSA-006 — High/Coverage — Secret gate did not cover the whole repository

**Affected:** GitHub workflow trigger coverage.

The heavy `Security Gates` workflow intentionally watched selected paths, so PRs confined to areas such as `pumpfun-chart`, `mcp-servers`, `intelligence`, `memecoin-intelligence` or `admin-site` did not necessarily execute secret scanning.

**Remediation:** `.github/workflows/secret-scan.yml` now runs the lightweight current-tree scan on every PR/push to `main` and the PR-diff scan on every PR. A full reachable-history scan is explicit/manual because known historical leaks would otherwise make every future PR permanently red until a coordinated history rewrite.

Local equivalent:

```bash
npm run security:audit:local
npm run security:audit:history
```

The first command is the blocking current-tree/regression gate; the second is the explicit historical audit.

Status: **FIXED IN CONFIGURATION — GITHUB EXECUTION VERIFICATION PENDING**.

### FSA-007 — High — Insecure subscription development Compose defaults

**Affected:**

- `solana-subscription-service/docker-compose.yml`
- `solana-subscription-service/.env.example`

The development stack published PostgreSQL, Redis, API, web and ngrok diagnostics on all host interfaces. PostgreSQL used a predictable development password and Redis had no password requirement.

**Remediation:**

- Postgres and Redis passwords are required Compose variables;
- Redis runs with `--requirepass` and its health check authenticates;
- API/bot receive authenticated database/cache URLs;
- host bindings for `5433`, `6380`, `4000`, `3000` and `4040` are loopback-only;
- the env template leaves required service passwords blank and labels non-secret URL placeholders.

Status: **FIXED IN SOURCE**.

## Re-reviewed high-risk areas with no new confirmed exploit

### Authentication / sessions

Reviewed controls include signed Telegram Mini App identity, Telegram freshness/replay resistance, pinned JWT algorithm/expiration, HttpOnly/SameSite cookies, CSRF/origin checks for cookie-authenticated mutations, login rate limits and admin-session expiry/revocation/strong-secret requirements. No new confirmed privilege-escalation path was found in these reviewed flows.

### IDOR / BOLA / role separation

No new confirmed IDOR was found in reviewed payment, order, task and user-sensitive paths. Existing code binds operations to authenticated identity and distinguishes subscriber/superuser/internal/admin scopes. `solana-launcher` continues to separate `BACKEND_API_KEY`, `SUBSCRIPTION_INTERNAL_KEY` and `SUBSCRIPTION_ADMIN_KEY` into separate trust domains.

### Payment / webhook integrity

No new confirmed current payment bypass was found. Reviewed protections include independent on-chain verification, failed-transaction rejection, exact recipient/amount/reference validation, unique transaction-signature constraints, atomic payment claim/entitlement extension and fail-closed webhook authentication.

### AI / cost controls

Reviewed AI-facing code uses bounded request sizes, bounded output-token settings, timeouts and application rate limits. No new confirmed AI cost-bomb path was identified in this source pass.

### XSS / command execution / SQL

Quick source-signature review did not find direct `dangerouslySetInnerHTML`, `innerHTML`, `eval(`, `shell=True` or `shell: true`. Reviewed command execution uses argument arrays with shell execution disabled. Reviewed admin/database code uses parameterized SQL and identifier allowlists where dynamic identifiers are required.

These results do not replace framework-specific SAST or browser/runtime testing.

## Local security gate — independent of Actions

Run from repository root:

```bash
npm run security:audit:local
```

This executes the current-tree secret scan plus `security/audit/full-repo-regression.py`. The regression gate protects the findings above, including Helius error redaction, SSRF validation, loopback development bindings, required service credentials, placeholder-bypass resistance and ZIP secret scanning.

Full known-history scan:

```bash
npm run security:audit:history
```

For deeper local/VPS AI-assisted testing:

```bash
npm run security:strix:deep
```

A Strix result is evidence only when `run.json` reports a completed run. An incomplete/budget-stopped scan is not clean.

## Open/manual/external items

### Historical credential rotation

Source changes cannot close historical credentials. Current tracking includes:

- SEC-012 — historical Telegram bot credential;
- SEC-013 — historical external `sk-` credential;
- FSA-001 — historical JWT-style credential found in this pass;
- historical Supabase service-role-style credential, if it authenticated to a real project.

Provider-side revoke/rotation and verification that old credentials are invalid are mandatory. Git-history rewriting is defense in depth after rotation and must be coordinated because commit IDs change.

### SEC-014 — upstream `bigint-buffer` advisory

The earlier audit documented a high-severity `bigint-buffer` advisory in the legacy Solana JavaScript dependency chain with no compatible upstream patched release in that chain. The existing time-bounded exception expires `2026-10-01`.

Before expiry, migrate away from the affected legacy dependency chain or adopt a supported graph in which the advisory is resolved. Do not extend the exception without a fresh exposure analysis and explicit owner decision.

### GitHub Actions

GitHub Actions currently fails before runner allocation. Observed security jobs had no allocated runner and no executed steps. Therefore this audit does **not** claim pytest, npm audit, pip-audit, TypeScript builds or workflow secret scans executed successfully on this branch.

### Live deployed verification

Not performed in this session. After deployment, an authorized owner should verify:

- only intended public ingress ports are reachable;
- DB/cache/broker/metrics/admin/internal ports are not externally reachable;
- production CORS/security headers are correct at the real ingress;
- authentication, CSRF and rate limits work through the deployed proxy/CDN;
- remediated findings do not reproduce in an authenticated staging/production-safe retest.

## Validation status

Completed in this source pass:

- cross-project manual review of sensitive areas listed above;
- deterministic high-risk signature review;
- source/configuration remediation of newly confirmed findings;
- local cross-project regression and secret gate implementation;
- RSS SSRF regression tests;
- repository-wide PR secret-gate coverage;
- credential-rotation documentation.

Still requires a working execution/provider/deployment environment:

- GitHub-hosted CI execution or equivalent clean-checkout local suites;
- fresh npm/pip dependency audit results for this exact final tree;
- provider credential revocation confirmation;
- deployed/live DAST and external reachability verification;
- a completed Strix deep run on the final merged tree.

## Final classification

After merge, the correct status is:

> **Full repository source pass completed; confirmed source/configuration findings from this pass remediated; operational, dependency, credential-rotation and live-deployment verification remain outstanding.**

Do not label the project "fully secure" until those external verification items are closed.
