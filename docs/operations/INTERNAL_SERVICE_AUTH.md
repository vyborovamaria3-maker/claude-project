# Internal service authentication for Solana Launcher

## Credential

`INTERNAL_SERVICE_API_KEY` is a dedicated 64-character hexadecimal secret for machine-to-machine calls. It must be distinct from `BACKEND_API_KEY`, `KOL_INTERNAL_KEY`, `SUBSCRIPTION_INTERNAL_KEY` and `SUBSCRIPTION_ADMIN_KEY`.

`deploy-production.sh` generates the key if absent, validates its format, stores it in `.env.server`, and makes it available to the server-side runtime environment. Production Compose passes it only to:

- Next.js frontend proxy (validator);
- FastAPI backend;
- Celery worker;
- Twitter Discovery process.

It is never exposed through `NEXT_PUBLIC_*` variables or the browser bundle.

## Allowed use

The key bypasses paid-user authentication only for:

- `POST /api/trade/dev-twitter` — the internal X collection operation.

The proxy still applies the heavy-route rate limit before checking the key. The comparison is constant-time. The key is not accepted for other paid routes, including developer forensics, and it does not grant access to the private `/api/database` namespace.

The same key authenticates the read-only deployment probe `GET /api/internal/health/wallet-summary`. That route returns readiness only and does not disclose wallet data.

Backend clients send the key in `x-internal-service-key`. Production clients fail closed if it is missing. The Twitter CLI also refuses to send it to a frontend base URL that differs from the configured internal frontend URL and does not follow redirects.

## HTTP method policy

- `POST /api/trade/dev-twitter` performs collection and persistence. GET returns 405.
- `POST /api/trade/dev-forensics` refreshes persisted forensic observations. GET returns 405.
- User-facing callers use POST with their normal authenticated session.
- Internal backend callers use the dedicated service key only for the X collection endpoint.

Do not log the header or place the key in query parameters. Rotate it by updating `.env.server` and redeploying all four server-side consumers together.
