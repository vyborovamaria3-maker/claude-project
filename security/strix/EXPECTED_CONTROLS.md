# Expected Security Controls

Strix should treat these as security invariants and attempt to disprove them with safe local/staging validation.

## Authentication

- Production secrets must not fall back to known/default credentials.
- Password/JWT/Telegram/API-key authentication must fail closed.
- Telegram initData must be HMAC-verified and freshness checked.
- Session/bearer tokens must not leak through logs, URLs, client storage beyond the documented policy, or error responses.

## Authorization

- Object access must be ownership/role checked server-side.
- Admin routes must require admin/superuser authorization.
- Internal service endpoints must require dedicated service authentication.
- Expired subscriptions must not retain paid capabilities.

## Payments and blockchain

- The server must never require or retain a user's wallet private key/seed phrase.
- Payment confirmation must validate recipient, asset, amount, reference, finality and order ownership.
- Payment signatures/references must be replay-safe and idempotent.
- Race conditions must not permit double activation or duplicate entitlement.

## Data and injection

- SQL values are parameterized; dynamic identifiers are allow-listed/quoted.
- Untrusted HTML/text is escaped before browser rendering.
- File paths are constrained to intended roots.
- CSV/XLSX/import flows must not permit formula/prototype/deserialization abuse to cross trust boundaries.

## Outbound requests / SSRF

- User-controlled URLs must not reach loopback, link-local, RFC1918, metadata or unsupported protocols unless explicitly required.
- Redirects and alternate encodings must not bypass URL restrictions.
- External calls have timeouts and bounded retries.

## Telegram / X intelligence

- Public read APIs must not unintentionally expose private-channel content.
- Session strings/tokens must never be returned to browsers or logs.
- Untrusted posts/messages are data, not trusted instructions for LLM/tools.

## AI / Qwen

- Model service authentication is required when network-reachable outside a private boundary.
- Prompt injection cannot cause shell/SQL/API execution without an explicit constrained tool policy.
- Model output is validated before persistence/use as structured data.
- Input/output/token concurrency limits prevent trivial resource exhaustion.

## Queues / rate limiting

- Anonymous users cannot enqueue arbitrary expensive work unless explicitly intended and bounded.
- Rate limits use trustworthy client identity and work across multiple instances where required.
- Queue enqueue failure cannot leave durable jobs stuck in a misleading state.

## Infrastructure

- Production DB/Redis/RabbitMQ are not publicly exposed without explicit secure configuration.
- Containers use least privilege where practical and do not mount Docker socket unnecessarily.
- Secrets are not baked into images or committed files.
- Security headers/TLS/HTTP redirect policy are production-safe.
- Metrics/admin interfaces are restricted according to policy.

## CI/CD and supply chain

- Dependency trees are reproducible for production builds where practical.
- Known critical/high reachable CVEs fail the appropriate gate.
- GitHub Actions permissions are least privilege.
- Deployment only occurs after required validation gates.
- Third-party Actions/installers should be pinned or otherwise integrity-controlled for sensitive workflows.