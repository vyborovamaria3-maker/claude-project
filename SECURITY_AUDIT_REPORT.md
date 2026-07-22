# Security Audit Report

Generated: 2026-07-22

Scope: `C:\Users\Рафаил\claude-project`, excluding dependency folders and build outputs.

## Confirmed Vulnerabilities

### Critical: Telegram callback account takeover

Affected files:

- `solana-launcher/backend/app/api/v1/auth.py`
- `solana-launcher/backend/app/schemas/auth.py`

Impact: `/api/v1/auth/telegram/callback` accepted a client-supplied `telegram_id`, created or loaded that user, and returned a JWT. An attacker could mint a token for any Telegram-linked account by guessing or knowing the victim Telegram ID.

PoC before patch:

```http
POST /api/v1/auth/telegram/callback
Content-Type: application/json

{"telegram_id":42,"username":"attacker"}
```

Expected vulnerable result before patch: `200` with `access_token`.

Patch applied:

- Replaced unsigned identity fields with signed Telegram `init_data`.
- Reused existing `verify_telegram_init_data`.
- Added tests for unsigned rejection, bad signature rejection, and valid signed login.

Status: Patched.

### High: Apify actor execution without auth guard

Affected file:

- `solana-launcher/app/api/integrations/apify/sandbox/route.ts`

Impact: `POST /api/integrations/apify/sandbox` could trigger an external Apify actor without the production auth guard used by other sensitive routes. This can burn credits, run unwanted external jobs, and expose integration behavior.

PoC before patch:

```http
POST /api/integrations/apify/sandbox
Content-Type: application/json

{"input":{"query":"anything"}}
```

Patch applied:

- Added `requireProdAuth(request)` to `POST`.

Status: Patched.

### High: Helius webhook becomes public when secret env is missing

Affected files:

- `telegram-miniapp/backend-new/src/config/index.ts`
- `telegram-miniapp/backend-new/src/controllers/webhookController.ts`

Impact: `HELIUS_WEBHOOK_SECRET` was typed as required but not validated at startup. If missing, webhook authorization became effectively disabled, allowing spoofed payment events to be submitted to the app.

PoC before patch:

```http
POST /webhook/helius
Content-Type: application/json

[{"signature":"fake","type":"TRANSFER","memo":"<known-payment-memo>","tokenTransfers":[...]}]
```

Patch applied:

- Added `HELIUS_WEBHOOK_SECRET` to required startup config.
- Normalized auth handling to accept `Authorization: Bearer <secret>` and the legacy raw token.

Status: Patched.

### Critical: Real secrets committed/stored in workspace

Affected files found by secret scan:

- `.codex/config.toml`
- `mcp-servers/.env`
- `solana-launcher/.env.development.local`
- `solana-launcher/data/x-auth/storage-state.json`

Impact: Exposed OpenAI, Figma, Helius, Firecrawl, Perplexity, and browser session credentials can be reused by anyone with access to the workspace or repository history.

PoC evidence:

```powershell
rg --hidden -g '!**/node_modules/**' -e "OPENAI_API_KEY|FIRECRAWL_API_KEY|PERPLEXITY_API_KEY|FIGMA_API_KEY|HELIUS_API_KEYS|storage-state.json" .
```

Patch applied:

- Added root `.gitignore` for `.codex/config.toml`, `.env*`, browser state, logs, databases, dependencies, and build outputs.
- Tightened `solana-launcher/.gitignore` with exact `storage-state.json` coverage.

Required manual action:

- Rotate every exposed key/token/session at the provider.
- Remove secrets from any repository history if these files were ever committed.

Status: Guardrails patched; rotation still required.

## Hardening Findings

### Medium: `telegram-miniapp/backend-new` exposes user status by arbitrary ID

Affected file:

- `telegram-miniapp/backend-new/src/controllers/subscriptionController.ts`

Impact: `GET /api/subscription/status?userId=...` returns account existence, subscription state, Telegram ID, and username for arbitrary IDs. Add Telegram initData verification or require an authenticated session before returning user-specific fields.

### Medium: root command wrappers use `shell: true`

Affected files:

- `scripts/gmgn-exec.mjs`
- `scripts/gmgn-market.mjs`
- `scripts/gmgn-wallet.mjs`

Impact: Current usage passes array arguments to `gmgn-cli`, but `shell: true` increases command-injection risk if future arguments become string-composed. Prefer `spawnSync("gmgn-cli", gmgnArgs, { stdio: "inherit", shell: false })`.

### Low: static miniapp HTML uses `innerHTML`

Affected file:

- `telegram-miniapp/frontend/static/index.html`

Impact: Watchlist item fields are rendered through template strings into `innerHTML`. If watchlist data can be user-controlled, this is XSS. Use DOM text nodes or escape user fields before rendering.

## Dependency Audit Summary

Commands run with `npm.cmd audit --json --omit=dev`.

- `telegram-miniapp/backend-new`: 1 low vulnerability (`body-parser` via Express stack), fix available.
- `solana-subscription-service/apps/api`: 9 total, including 3 high, mostly through `@solana/web3.js`, `@solana/spl-token`, `bigint-buffer`, plus `body-parser`.
- `solana-launcher`: 45 total, including 1 critical and 18 high. Highest-impact cluster is `@lingo.dev/compiler` transitive dependencies (`fast-xml-parser`, `ws`, `lodash`, MCP SDK), plus `xlsx` with no npm audit fix available.

Recommended dependency actions:

- Run `npm audit fix` only after reviewing lockfile changes.
- For `solana-launcher`, consider removing or isolating `@lingo.dev/compiler` from production dependencies if it is build-time only.
- Replace `xlsx` or sandbox XLSX imports because npm audit reports no fix.
- Track Solana ecosystem advisory fixes manually; npm currently suggests semver-major/downgrade-shaped fixes for some packages, so do not apply blindly.

## Verification

Passed:

- `telegram-miniapp/backend-new`: `npm.cmd run build`
- `solana-launcher`: `npx.cmd tsc --noEmit`

Blocked:

- `solana-launcher/backend`: `pytest` is not installed in the available Python runtime, so the new FastAPI auth tests could not be executed here.
- `solana-launcher`: `npm.cmd run lint` failed because `next lint` is not supported by the installed Next CLI in this project layout.
