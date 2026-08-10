# Authentication and Authorization Matrix

This matrix is the expected policy for future authenticated staging tests. It is not permission to attack production.

## Actors

- `ANON` — unauthenticated client
- `USER_A` — normal paid/active user A
- `USER_B` — normal paid/active user B
- `EXPIRED` — authenticated user with expired entitlement
- `TG_A` — Telegram user A
- `TG_B` — Telegram user B
- `ADMIN` — authorized administrator
- `SERVICE` — internal service using a dedicated API key

## Expected access

| Resource / action | ANON | USER_A | USER_B | EXPIRED | ADMIN | SERVICE |
|---|---:|---:|---:|---:|---:|---:|
| Public landing/health intended for public use | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW |
| Own user profile | DENY | ALLOW own | ALLOW own | ALLOW own | ALLOW | policy-specific |
| Another user's profile | DENY | DENY | DENY | DENY | ALLOW if admin feature | DENY unless explicitly required |
| Paid analysis features | DENY | ALLOW | ALLOW | DENY | ALLOW | policy-specific |
| Own subscription order | DENY | ALLOW own | ALLOW own | ALLOW own | ALLOW | ALLOW where required |
| Another user's subscription order | DENY | DENY | DENY | DENY | ALLOW only through admin tooling | DENY by default |
| Complete/mark subscription paid | DENY | DENY direct | DENY direct | DENY | ADMIN only if designed | ALLOW only through validated internal flow |
| Admin API / feature flags / DB explorer | DENY | DENY | DENY | DENY | ALLOW | DENY unless explicit maintenance role |
| Telegram session attach/control | DENY | DENY | DENY | DENY | ALLOW | policy-specific |
| Telegram/X public analysis read | policy decision | policy decision | policy decision | policy decision | ALLOW | ALLOW |
| Private Telegram source content | DENY | DENY by default | DENY by default | DENY | ALLOW only if policy explicitly permits | ALLOW only if required and audited |
| Financial transaction builder | DENY | ALLOW authenticated | ALLOW authenticated | DENY if entitlement required | ALLOW | DENY unless designed |
| Server-side signing with user private key | NEVER | NEVER | NEVER | NEVER | NEVER | NEVER |

## Mandatory negative tests

1. `USER_A` requests `USER_B` objects by changing IDs, payloads, wallet addresses or Telegram IDs.
2. `USER_A` calls every admin route discovered in source.
3. `EXPIRED` reuses a previously valid token/session against paid features.
4. `TG_A` attempts to read/complete `TG_B` subscription order.
5. `ANON` calls task/queue, export, metrics, analysis and integration endpoints.
6. Rotate `X-Forwarded-For` and proxy headers to verify rate-limit trust boundaries.
7. Replay a payment signature/reference against another order in a local/staging test environment.
8. Reuse demo-access identifiers to test one-time enforcement.
9. Send malformed/expired/future Telegram initData fixtures; never use stolen real initData.
10. Verify API-key role separation between admin/user/service keys in `memecoin-intelligence`.

## Evidence required

For each failed authorization invariant record request shape, actor, object owner, expected status, actual status and the exact route/source location.