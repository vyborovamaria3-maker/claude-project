# Strix Profile 03 — External Integrations, LLM and Infrastructure

Follow `security/strix/ROE_SOURCE_ONLY.md` strictly.

## Outbound HTTP / SSRF

Inventory every outbound client and configurable base URL, including:

- Qwen/OpenAI-compatible inference
- Apify
- Solana RPC
- Helius
- Telegram/X/Nitter/browser-session collectors
- metadata/image/webhook fetches

For each, determine whether attacker-controlled input can influence scheme, host, port, path, redirect destination, DNS resolution or headers.

Check defenses against:

- localhost / loopback
- RFC1918/private networks
- link-local/metadata endpoints
- IPv6 loopback/private ranges
- alternate IP encodings
- redirects to private destinations
- unsafe protocols

Do not send any request to production or third-party services. Use source proof or local mocks only.

## LLM / AI security

Trace untrusted Telegram/X/user content into prompts and downstream consumers.

Test source-level paths for:

- direct/indirect prompt injection
- system-prompt or secret disclosure
- cross-user/context leakage
- model output used as SQL/shell/file path/URL without validation
- model output rendered as HTML without escaping
- agent/tool invocation controlled by model text
- oversized input/token/cost exhaustion
- cache-key confusion between model/mode/config variants
- poisoned cached output without schema revalidation

Only classify prompt injection as a vulnerability when it creates a security-relevant downstream effect.

## Secrets and crypto

Review:

- hard-coded/default secrets
- JWT/session/API key generation and comparison
- Telegram session strings
- private keys/seed phrases
- secret leakage through logs, query strings, client bundles, Docker build args or CI logs
- weak encryption/key derivation or insecure randomness

## Docker / Nginx / services

Review:

- root containers
- published DB/Redis/RabbitMQ/metrics/admin ports
- privileged mode/capabilities/docker.sock
- writable mounts
- healthchecks
- resource limits
- TLS/HSTS/CSP/cookie security
- trusted proxy/X-Forwarded-For handling
- internal-only endpoints exposed by reverse proxy

## CI/CD supply chain

Review:

- mutable GitHub Action tags
- excessive workflow permissions
- untrusted PR code + secrets
- command injection through workflow inputs
- dependency pinning/lockfiles
- install scripts
- Docker base image pinning
- SSH host verification
- production deployment gates/rollback

Do not auto-fix.
