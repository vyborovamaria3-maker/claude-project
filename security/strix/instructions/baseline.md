# Strix Source Baseline Instructions

Follow `security/strix/ROE.md` strictly.

Perform a source-aware white-box security assessment of the selected target. Do not attack production or third-party services.

## Primary objectives

1. Build an attack-surface inventory: routes, auth, roles, object ownership, databases, queues, external HTTP/RPC calls, file handling, model/LLM integration, Docker, Nginx and CI/CD.
2. Trace attacker-controlled inputs to security-sensitive sinks.
3. Prioritize reachable vulnerabilities over theoretical patterns.
4. Validate candidates with non-destructive local PoCs/tests inside the sandbox when feasible.
5. Explicitly try to disprove each candidate by checking upstream validation and downstream guards.

## Vulnerability classes

- authentication bypass, weak/default credentials, JWT/session flaws
- BOLA/IDOR, privilege escalation, missing role/ownership checks
- SQL/NoSQL/command/template injection
- XSS/DOM XSS, prototype pollution, unsafe deserialization
- SSRF, redirect/proxy bypass, path traversal/file disclosure
- webhook/signature validation flaws
- race conditions, replay, idempotency and TOCTOU
- business-logic abuse in subscriptions/payments/wallet operations
- queue/resource abuse and rate-limit bypass
- secret exposure, logging leakage and insecure defaults
- dependency/SCA and supply-chain risks
- Docker/Nginx/CI/CD misconfiguration
- Telegram/X privacy boundary violations
- LLM prompt injection or unsafe model-output/tool boundaries

## Reporting standard

For every candidate include:

- status: CONFIRMED / NEEDS_VERIFICATION / HARDENING / FALSE_POSITIVE
- severity and confidence
- CWE/OWASP mapping where applicable
- affected file(s) and exact line(s) where possible
- route/entrypoint and attacker privileges
- source -> transformations -> sink data flow
- safe reproduction/local PoC
- actual impact
- security control that should have prevented it
- false-positive analysis
- minimal remediation direction
- regression test recommendation

Do not count a grep match, vulnerable dependency version, missing header or theoretical sink as a confirmed vulnerability without reachability/impact analysis.

Do not modify project source code during the audit.