# Strix Profile 02 — Authentication, Authorization, Payments and Business Logic

Follow `security/strix/ROE_SOURCE_ONLY.md` strictly.

Focus only on high-value identity and business-logic paths.

## Authentication

Review:

- password login / registration
- JWT creation, validation, expiry and revocation assumptions
- Telegram initData verification and timestamp/replay handling
- Phantom/wallet challenge flows
- admin authentication/session cookies
- internal API keys and service-to-service auth
- default/fallback credentials and secrets
- account linking/merging
- login enumeration and brute-force controls

## Authorization / IDOR matrix

Reason through at least these actors:

- anonymous
- normal user A
- normal user B
- expired/subscription-inactive user
- Telegram user A
- Telegram user B
- admin/superuser
- internal service

For sensitive objects/routes, verify horizontal and vertical authorization. Explicitly test source-level paths for:

- user A accessing user B order/profile/data
- normal user calling admin routes
- anonymous access to authenticated resources
- expired user accessing paid features
- user-controlled IDs/mints/wallets/order payloads used without ownership checks

## Payments / subscription business logic

Trace end-to-end:

create order -> payment reference -> on-chain verification -> completion -> credential/subscription issuance.

Check:

- amount/currency/decimal manipulation
- recipient substitution
- payment-reference reuse
- signature replay across orders
- double completion / concurrent completion
- TOCTOU/race conditions
- free-demo reuse
- order cancellation/recreation abuse
- status transition bypass
- old/expired transaction acceptance
- user A paying/claiming user B order
- idempotency and locking

## Transaction builders

Verify that server-side transaction builders cannot be abused to:

- sign with a server-held user private key
- redirect funds to attacker-chosen fee recipients unexpectedly
- bypass amount/slippage/fee limits
- invoke arbitrary programs/accounts through unvalidated input

## Required output

Only report issues with a concrete reachable path. Include a source-level reproduction or safe local test plan and exact file/line references. Do not contact live RPC/payment systems and do not auto-fix.
