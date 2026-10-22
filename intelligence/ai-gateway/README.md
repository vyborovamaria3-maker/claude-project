# AI Analysis Gateway — opt-in local server, model API adapter

**Stage:** offline-tested Draft PR #166, dependent on Sprint 1 #165.
No real model account or paid request has been executed or authorized by this
repository change. This gateway is **not** a trading engine or public chatbot.

## Data flow and role boundaries

```text
X PG, TG PG, Blockchain SQLite
   -> opt-in audited Outbox -> isolated Intelligence PG
   -> loopback :3182 /tokens/:id/ai-context [AI Bearer]
   -> loopback :3183 POST /api/ai/v1/analyze-token [gateway client Bearer]
   -> fixed HTTPS OpenAI Responses endpoint [provider key, explicitly enabled]
```

The model receives only the gateway's **explicitly allowlisted projection**:
canonical token ID, as-of boundary, bounded X/TG and blockchain evidence
sample counts (separate, NOT population totals), legacy timeline sample counts,
and prevalidated numeric feature snapshot or `status=missing`. Raw tweets,
Telegram message content, identifiable evidence IDs, wallet addresses,
freeform coverage labels, SQL, DSNs, and API credentials do not enter the
model's input. The gateway **cannot accept arbitrary user prompts or SQL**.

Data remains **untrusted facts**, not model instructions. The provider is
given no tools; storage is disabled with `store:false`, output is capped,
request timeout enforced, responses are bounded in size, and redirects
forbidden. Actual data-handling behavior still depends on the provider
account's terms and settings; operators must review that independently.

## Three distinct credentials

1. `INTELLIGENCE_API_TOKEN`: ordinary service credential, NOT usable for AI.
2. `INTELLIGENCE_AI_API_TOKEN`: credential for `/ai-context`, held only by
   the gateway server; NOT usable for regular Intelligence API routes.
3. `AI_GATEWAY_CLIENT_TOKEN`: authenticates the trusted application backend
   calling `POST /api/ai/v1/analyze-token`; NOT usable on Intelligence.
4. `OPENAI_API_KEY`: external model provider credential; NEVER passed to
   source databases, the frontend, API request body or model input.

Generate each independently, store in a host-managed secret store, rotate
regularly. Do not check into GitHub, echo to logs, or place in a frontend.

## Startup prerequisites and explicit spend opt-ins

Requires Node 22, installed `intelligence` dependencies, and built
`packages/contracts`, `packages/event-outbox`, `intelligence`. Required
destination PG migrations: 001, 002, 003 (feature store), 004 and 005,
with SELECT-only role. The AI read model and gateway are OFF by default.

Start the **existing** Intelligence API with the following server-side
configuration (values omitted intentionally):

```text
INTELLIGENCE_API_ENABLED=true
INTELLIGENCE_AI_API_ENABLED=true
INTELLIGENCE_DATABASE_URL=<separate-Intelligence-PostgreSQL-DSN>
INTELLIGENCE_API_TOKEN=<independently-generated-server-secret>
INTELLIGENCE_AI_API_TOKEN=<independently-generated-AI-only-secret>
INTELLIGENCE_API_PORT=3182
```

From `intelligence/`: `npm run api:local`.

The gateway itself **refuses startup** unless all three opt-ins are true:

```text
AI_GATEWAY_ENABLED=true
AI_GATEWAY_EGRESS_ENABLED=true
INTELLIGENCE_AI_API_ENABLED=true
AI_GATEWAY_CLIENT_TOKEN=<independently-generated-backend-secret>
INTELLIGENCE_AI_API_TOKEN=<same-private-AI-read-model-secret-as-above>
INTELLIGENCE_API_PORT=3182
AI_GATEWAY_PORT=3183
OPENAI_API_KEY=<private-model-provider-key>
AI_GATEWAY_MODEL=<valid-model-id-owned-by-operator>
```

Then from `intelligence/`: `npm run ai:gateway`.

Both servers **bind only to 127.0.0.1**. The code does not provide TLS,
public routing, account-specific authorization, multi-tenant isolation or
network exposure. Production use needs a separately reviewed authenticated
backend proxy / gateway and operator-controlled egress policies; never put
the Bearer token in a browser or expose the port publicly. Rate limits are
per-process safeguards, NOT a substitute for principal-level quotas.

The provider egress target is **hardcoded** to
`https://api.openai.com/v1/responses`; the user cannot pass a custom URL,
headers, model name, arbitrary prompt, or tool definitions. The model name
is the server-validated configured value, not the caller's input. For another
provider, add an explicitly reviewed adapter; do not use a user-provided URL.

## Request contract

Only server-to-server calls:

```http
POST http://127.0.0.1:3183/api/ai/v1/analyze-token
Authorization: Bearer <AI_GATEWAY_CLIENT_TOKEN>
Content-Type: application/json

{
  "tokenId": "solana:So11111111111111111111111111111111111111112",
  "occurredBefore": "2026-10-19T22:00:00.000Z",
  "knownAt": "2026-10-20T01:00:00.000Z",
  "limit": 25
}
```

Only these four keys are allowed. Canonical mint / UTC dates are strictly
validated, no future knowledge cutoff, `occurredBefore <= knownAt`.
`limit`: default 25, maximum 50. Request body max 2 KiB. Invalid requests
are 400 without database/provider access; wrong token 401; unknown routes
404; rate exceeded 429; external/destination failures 503 with a generic
error. No provider error bodies or private identifiers are returned.

Example success shape:

```json
{
  "schemaVersion": "ai-analysis-v1",
  "tokenId": "solana:So11111111111111111111111111111111111111112",
  "asOf": {
    "occurredBefore": "2026-10-19T22:00:00.000Z",
    "knownAt": "2026-10-20T01:00:00.000Z"
  },
  "analysis": "<model's bounded, unverified interpretation>",
  "model": "<configured-provider-model>",
  "classification": "unverified_model_interpretation",
  "evidenceCompleteness": "unknown",
  "isTradingSignal": false,
  "providerFinalityVerified": false
}
```

`analysis` is a **model opinion**, not a verified source fact or advice to
trade; no automated trade or PnL is generated. The gateway makes one read of
the destination Intelligence API, then at most one provider call. No
background sessions, hidden retries or automatic billing loops.

## Validation

`npm --prefix intelligence run check` tests the gateway without live
provider calls or secrets via in-process HTTP/Response fixtures:
- Separate AI/gateway credentials, explicit opt-ins, localhost transport.
- Real HTTP chain from Intelligence read model to client gateway response.
- Canonical identity / historical as-of validation / no arbitrary prompt.
- Bounded per-source counts, missing vs zero, no raw text / wallet IDs.
- Fixed TLS egress target, no tools, no storage and capped request output.
- Rollback/503/no provider/DB detail leaks when a downstream call fails.

`npm --prefix intelligence run ai:gateway` **must not** be executed in
development with real keys unless explicitly approved.

## Open release blockers

- PR #165 dependency and latest CI green; PR #166 latest CI green.
- Operator-approved real source canary with validated mint RPC and queue
  health; historical coverage, freshness/lag and data-quality source
  watermark materialization remain unverified.
- Destination least-privilege read role, backup/restore and revocation tests.
- End-user authentication, permissions, explicit consent and secure proxy.
- Provider data residency/privacy/retention and cost quota review.
- No model-output-to-trading execution path without independent validation.
