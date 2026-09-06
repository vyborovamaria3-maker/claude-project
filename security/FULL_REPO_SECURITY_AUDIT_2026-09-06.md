# Full Repository Security Audit — 2026-09-06

Repository: `vyborovamaria3-maker/claude-project`

Audit type: white-box source/configuration review with deterministic security-pattern checks and manual review of authentication, authorization, payments, webhooks, outbound requests, secrets, infrastructure defaults, MCP integrations and CI/security tooling.

This report is a **source audit**, not a claim that the deployed system is fully secure. GitHub-hosted Actions were unavailable during the audit and no owner-authorized live DAST target was exercised in this session.

## Executive summary

This pass extended the earlier `vibe-audit` remediation beyond `solana-launcher` to the repository's other applications and tooling.

New confirmed findings fixed in source:

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| FSA-001 | Critical/High | JWT-style external credential committed in `pumpfun-chart` source | CURRENT SOURCE FIXED — ROTATION REQUIRED |
| FSA-002 | High | Helius API key could be disclosed by MCP error text through a credential-bearing response URL | FIXED IN SOURCE |
| FSA-003 | High | RSS outbound fetch allowed DNS/private-network and redirect-based SSRF paths | FIXED IN SOURCE |
| FSA-004 | High/Hardening | `memecoin-intelligence` development API/web were host-exposed while development RBAC may be disabled | FIXED IN SOURCE |
| FSA-005 | High | Secret scanner could fail open when placeholder text appeared on the same line as a real secret | FIXED IN SOURCE |
| FSA-006 | High/Coverage | Repository secret scanning did not trigger for several top-level project areas | FIXED IN SOURCE |
| FSA-007 | High | `solana-subscription-service` development Compose exposed DB/cache/API/web/ngrok and used weak/no service authentication | FIXED IN SOURCE |

Previously known items that remain operationally open:

- provider-side rotation/revocation of historically committed credentials;
- Git history cleanup after rotation where desired/required;
- the upstream-blocked `bigint-buffer` advisory in the legacy Solana JavaScript dependency chain, with the existing exception expiring `2026-10-01`;
- dependency audits and regression suites must actually execute once a runner/local build environment is available;
- owner-authorized deployed-service reachability/DAST verification remains pending.

## Scope reviewed

The audit reviewed the current repository structure and sensitive code/configuration across:

- `solana-launcher` — FastAPI backend, subscription authorization, admin bootstrap, intelligence endpoints, tasks, Docker/runtime security;
- `solana-subscription-service` — Express/Prisma auth, cookies, Telegram verification, wallet/subscription/payment/webhook flows, on-chain verification, development and production Compose;
- `telegram-miniapp` — legacy backend/bot/frontend identity and subscription/payment paths;
- `memecoin-intelligence` — API access policy/RBAC/configuration, AI service controls, development and production Compose;
- `intelligence` — external web/RSS/YouTube provider clients and shared URL validation;
- `admin-site` — authentication/session handling, production controls, query/database access and export handling;
- `mcp-servers` — Solana/Helius, Pump.fun/database and X integrations;
- `pumpfun-chart` — backend source and credential exposure;
- root scripts and local Strix integration;
- `.github/workflows` and repository secret/security automation;
- prior security audit findings and remaining dependency/rotation exceptions.

Supporting source-signature searches found no current indexed hits for direct `dangerouslySetInnerHTML`, direct `innerHTML`, `eval(`, `shell=True`, or `shell: true`. These searches are supporting evidence only and are not a substitute for SAST/runtime testing.

## Confirmed findings and remediation

### FSA-001 — Critical/High — JWT-style credential committed in `pumpfun-chart`

**Affected:** `pumpfun-chart/backend/candle-aggregator.js`

A JWT-like credential was present literally before the JavaScript file's normal header. Because the value entered Git history, deleting it from the current tree does not make the credential safe.

**Remediation applied:**

- removed the credential from the current source tree;
- added the JWT pattern to repository secret scanning/regression protection;
- documented provider-side rotation/revocation and history-cleanup requirements without reproducing the value.

**Closure requirement:** identify the issuing provider from trusted provider/deployment records, revoke/rotate the old token, review provider audit logs and verify the old token no longer authenticates.

Status: **CURRENT SOURCE FIXED — EXTERNAL ROTATION REQUIRED**.

---

### FSA-002 — High — Helius API key exposure in MCP error messages

**Affected:** `mcp-servers/src/solana-server.ts`

Helius requests place the API credential in the query string. The previous error helper included `response.url`; therefore a failed MCP request could copy the credential-bearing URL into MCP/model logs or transcripts. A reflected response body could also repeat the credential.

**Remediation applied:**

- error text no longer includes `response.url`;
- configured Helius credentials are defensively redacted from response-body details;
- response error detail is bounded before being surfaced.

Status: **FIXED IN SOURCE**.

---

### FSA-003 — High — RSS SSRF through DNS resolution and redirects

**Affected:**

- `intelligence/security/urls.py`
- `intelligence/providers/rss/client.py`

The original URL validator rejected literal localhost/private IP URLs but did not resolve ordinary hostnames before connecting. The RSS client also followed redirects through the standard library without revalidating the redirect destination. A public-looking hostname or public feed redirect could therefore target loopback/private/link-local infrastructure.

**Remediation applied:**

- added outbound URL validation that resolves the hostname immediately before connection;
- all resolved addresses must be globally routable;
- added a redirect handler that revalidates every redirect target using the same outbound policy;
- retained HTTP/HTTPS-only, no-credentials, size and timeout restrictions;
- added regression tests covering private DNS resolution rejection and public resolution acceptance.

Residual note: this significantly closes the practical private-network/redirect SSRF paths, but application-layer hostname validation alone cannot provide a formal guarantee against every DNS rebinding/transport race. Network-level egress policy remains recommended for high-assurance deployments.

Status: **FIXED IN SOURCE / NETWORK EGRESS DEFENSE RECOMMENDED**.

---

### FSA-004 — High/Hardening — Development intelligence API exposed beyond localhost

**Affected:** `memecoin-intelligence/docker-compose.yml`

Development access policy may intentionally disable RBAC for local compatibility, while the API and web development ports were published on all host interfaces. This made local development assumptions unsafe on a workstation/VPS reachable from another network host.

**Remediation applied:**

- API `3001` and web `5173` are now published only on `127.0.0.1`;
- the already local-only database/cache/Qwen bindings remain local;
- container-to-container communication is unchanged.

Status: **FIXED IN SOURCE**.

---

### FSA-005 — High — Secret scanner placeholder bypass

**Affected:** `security/audit/secret-scan.py`

The scanner previously skipped an entire line whenever any placeholder marker occurred on the line. A real secret and a harmless marker such as a template token on the same line could therefore cause a false negative.

**Remediation applied:**

- secret rules now inspect each exact regex match;
- placeholder handling applies only to the matched value, not to unrelated text elsewhere on the line;
- the local full-repo regression gate explicitly verifies that placeholder text cannot suppress a JWT-like match.

Status: **FIXED IN SOURCE**.

---

### FSA-006 — High/Coverage — Secret scan did not cover every repository area on every PR

**Affected:** `.github/workflows/security-gates.yml` trigger coverage.

The existing heavy security workflow intentionally watched selected paths. Changes confined to areas such as `pumpfun-chart`, `mcp-servers`, `intelligence`, `memecoin-intelligence` or `admin-site` did not necessarily start the secret-scan job. This contributed to a repository-wide detection gap.

**Remediation applied:**

Added `.github/workflows/secret-scan.yml`, a lightweight repository-wide workflow triggered on every PR to `main` and every push to `main`. It performs:

- current tracked-file secret scan;
- newly introduced PR-line scan;
- reachable Git-history scan;
- full-history checkout with persisted GitHub credentials disabled.

GitHub Actions is currently unable to allocate runners for this repository, so the workflow exists as future protection but did **not** execute during this audit.

Status: **FIXED IN CONFIGURATION — EXECUTION VERIFICATION PENDING**.

---

### FSA-007 — High — Insecure development Compose defaults in subscription service

**Affected:**

- `solana-subscription-service/docker-compose.yml`
- `solana-subscription-service/.env.example`

The development stack published PostgreSQL, Redis, API, web and ngrok diagnostic ports on all interfaces. PostgreSQL used a predictable development password and Redis had no password requirement.

**Remediation applied:**

- Postgres and Redis passwords are explicit required Compose variables;
- Redis runs with `--requirepass` and its health check authenticates;
- API/bot receive authenticated database/cache URLs;
- development host bindings are limited to loopback for `5433`, `6380`, `4000`, `3000` and `4040`;
- the env template contains blank required service-password variables and clearly marked non-secret URL placeholders.

Status: **FIXED IN SOURCE**.

## Previously fixed high-risk areas re-reviewed

### Authentication / session handling

No new confirmed privilege-escalation issue was found in the reviewed current flows. Re-reviewed controls include:

- signed Telegram Mini App identity rather than client-supplied Telegram IDs;
- Telegram `auth_date` freshness/replay resistance;
- pinned JWT algorithm and expiration requirements;
- HttpOnly/SameSite cookie handling in the subscription service;
- CSRF/origin protections for cookie-authenticated mutations;
- password/login rate limiting;
- admin session signing, expiry/revocation and production strong-secret requirements.

### IDOR / BOLA / role separation

No new confirmed IDOR was found in reviewed current payment, order, task and user-sensitive paths. Existing protections bind operations to authenticated identity and distinguish subscriber/superuser/internal/admin scopes.

The `solana-launcher` subscription remediation continues to separate:

- `BACKEND_API_KEY` — backend/intelligence trust domain;
- `SUBSCRIPTION_INTERNAL_KEY` — checkout/order/provisioning trust domain;
- `SUBSCRIPTION_ADMIN_KEY` — subscription-administration trust domain.

### Payment and webhook integrity

No new confirmed payment bypass was found in the current reviewed implementation. Existing protections include:

- independent on-chain transaction verification;
- rejection of failed transactions;
- exact recipient/amount/reference validation;
- unique transaction-signature constraints;
- atomic claim/entitlement extension for concurrent webhook deliveries;
- webhook authentication that fails closed when required secrets are missing.

### AI / cost controls

Reviewed AI-facing code uses bounded request sizes, bounded output-token settings, timeouts and application rate limits. No new confirmed AI cost-bomb path was identified in this source pass.

### XSS / command execution / SQL

The quick source-signature pass did not find direct `dangerouslySetInnerHTML`, `innerHTML`, `eval(`, `shell=True` or `shell: true` uses. Reviewed command execution uses argument arrays with shell execution disabled. Reviewed admin/database paths use parameterized SQL and identifier allowlists where dynamic identifiers are needed.

This does not replace framework-specific SAST or runtime browser testing.

## Local security gate added because Actions is unavailable

The repository now provides:

```bash
npm run security:audit:local
```

This runs the current-tree secret scanner plus `security/audit/full-repo-regression.py` without GitHub Actions.

The regression gate checks, among other invariants:

- the removed `pumpfun-chart` JWT does not return;
- Helius MCP errors do not include credential-bearing response URLs;
- Helius response details remain redacted;
- development API/service ports remain loopback-bound;
- subscription Redis remains authenticated and required secrets fail closed;
- RSS outbound requests resolve only to public addresses and redirect validation remains present;
- placeholder text cannot bypass secret detection.

For deeper AI-assisted source testing, the previously added local/VPS Strix runner remains available:

```bash
npm run security:strix:deep
```

A Strix result is valid evidence only when its run completes successfully; an incomplete/budget-stopped run must not be interpreted as clean.

## Open / manual / external items

### Credential rotation

The following historical credential findings cannot be closed by source changes alone:

- SEC-012 — historical Telegram bot credential;
- SEC-013 — historical external `sk-` credential;
- FSA-001 — newly identified historical JWT-style credential;
- historical Supabase service-role-style credential, if it authenticated to a real project.

Provider-side revoke/rotation and verification that old credentials are invalid are mandatory. Git-history rewriting is defense in depth after rotation and requires coordinated repository maintenance.

### SEC-014 — upstream `bigint-buffer` advisory

The earlier audit documented a high-severity `bigint-buffer` advisory in the legacy Solana JavaScript dependency chain with no compatible upstream patched version in that chain. The existing time-bounded exception expires `2026-10-01`.

Required action before expiry: migrate away from the affected legacy dependency chain or otherwise adopt a supported dependency graph in which the advisory is resolved. Do not extend the exception without a fresh exposure analysis and explicit owner decision.

### GitHub Actions

GitHub Actions is currently failing before runner allocation. Observed security jobs have no allocated runner and no executed steps. Therefore this audit does not claim that pytest, npm audit, pip-audit, TypeScript builds or secret workflows executed successfully on this branch.

### Live deployed verification

Not performed in this session. After deployment, an authorized owner should verify:

- only intended public ingress ports are reachable;
- internal DB/cache/broker/metrics/admin ports are not externally reachable;
- production CORS/security headers are correct at the real ingress;
- authentication/CSRF/rate limits behave correctly through the deployed proxy/CDN;
- fixed findings do not reproduce in an authenticated staging/production-safe retest.

## Validation status

Completed in this source pass:

- cross-project manual source review of sensitive areas listed above;
- deterministic high-risk signature review;
- source/configuration remediation for all newly confirmed findings in this report;
- local regression/secret gate implementation;
- regression tests added for RSS DNS-based SSRF behavior;
- credential-rotation documentation updated.

Not completed because the execution environment was unavailable or requires owner/provider access:

- GitHub-hosted CI execution;
- clean-checkout npm/pip dependency audits during this specific pass;
- provider credential revocation confirmation;
- deployed/live DAST and external reachability checks;
- a completed Strix deep run on the final merged tree.

## Final classification

After this audit branch is merged, the correct status is:

> **Full repository source pass completed; confirmed source/configuration findings from this pass remediated; operational, dependency, credential-rotation and live-deployment verification remain outstanding.**

Do not label the project "fully secure" until those external verification items are closed.
