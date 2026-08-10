# Strix Rules of Engagement — Cycle 1 Source-Only

## Authorization

This assessment is authorized only for source code in `dima09090/claude-project` and local/sandbox processes created from that source.

## Allowed targets

- repository root
- `solana-launcher/`
- `solana-launcher/backend/`
- `admin-site/`
- `memecoin-intelligence/`
- local containers/processes created exclusively for the scan

## Explicitly prohibited in Cycle 1

Do not send active security-test traffic to:

- `potapoff.fun` or any production/staging host
- Solana mainnet/devnet RPC unless a local mock is used
- Telegram infrastructure or real Telegram accounts/channels
- X/Twitter/Nitter infrastructure
- Apify or other third-party APIs
- real wallets or payment addresses
- Helius or other webhook providers
- any IP/domain not created inside the audit sandbox

Do not:

- submit real blockchain transactions
- brute-force credentials
- perform denial-of-service/load testing
- delete or corrupt repository data
- exfiltrate secrets
- change production infrastructure
- auto-fix findings

## Validation policy

A finding is CONFIRMED only when all of the following are available:

1. attacker-controlled source/input
2. reachable data/control flow to the vulnerable sink or authorization decision
3. concrete security impact
4. safe local reproduction or source-level proof
5. exact file and line references

If a claim depends on unknown production configuration, classify it `NEEDS_PRODUCTION_VERIFICATION`, not confirmed.

If dynamic validation would require contacting an external or production system, stop at a source-level proof and clearly state the missing validation step.

## Required finding fields

For every candidate provide:

- ID
- severity and confidence
- CWE / OWASP category
- component
- exact file and line
- route/entrypoint when applicable
- attacker prerequisites
- source -> validation -> sink trace
- safe reproduction steps
- observed/expected behavior
- business impact
- false-positive checks performed
- minimal remediation recommendation
- suggested regression test

## Priority areas

Prioritize:

- authentication and session management
- authorization / IDOR / privilege escalation
- payment and subscription business logic
- Telegram initData/session handling
- X/Telegram intelligence privacy boundaries
- SQL/command/template injection
- SSRF and unsafe outbound HTTP
- path traversal and file handling
- race conditions and replay
- secret/default-credential handling
- queue/resource exhaustion
- LLM prompt injection and tool/data-flow boundaries
- dependency reachability and supply-chain risk
- Docker / Nginx / CI/CD misconfiguration

## Noise control

Do not report:

- dependency CVEs without identifying whether the vulnerable code is reachable
- generic missing-header findings without a concrete threat model
- dynamic SQL as SQL injection when identifiers are allow-listed/quoted and values are parameterized
- theoretical XSS where output is correctly escaped
- development-only behavior as production vulnerability unless production reachability is shown

## Output state

Do not modify application source. Cycle 1 is audit-only.
