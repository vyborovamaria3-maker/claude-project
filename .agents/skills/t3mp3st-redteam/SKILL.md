---
name: t3mp3st-redteam
description: Structured authorized red-team and penetration-testing workflow for applications and infrastructure. Use when the user explicitly requests security reconnaissance, vulnerability assessment, exploit validation, red-team planning, PoC development, or offensive-security reporting for assets they own or are authorized to test.
---

# T3MP3ST Redteam

## Authorization Gate

Use only for authorized targets. If ownership or permission is unclear, ask for scope before active testing. Stay within the declared asset list, environment, rate limits, and rules of engagement.

## Workflow

1. Recon: map attack surface from code, configs, routes, dependencies, exposed services, authentication flows, secrets handling, and deployment artifacts.
2. Plan: list hypotheses, required evidence, tools, and stop conditions. Include conditions for abandoning a path.
3. Execute: test hypotheses safely. Prefer local reproduction, static analysis, unit/integration tests, and controlled requests against authorized environments.
4. Reflect: keep a journal of confirmed, disproven, and inconclusive hypotheses. Re-rank risk as evidence changes.
5. Report: provide findings with impact, affected assets, evidence, reproduction steps, remediation, and residual risk.

## Proof Standards

- Demonstrate exploitability with a working PoC only inside authorized scope.
- Prefer non-destructive PoCs that prove control or data access without exfiltrating sensitive data.
- Mark theoretical risks separately from confirmed vulnerabilities.
- Do not claim success without observable evidence.

## Safety Boundaries

- Do not perform persistence, stealth, credential theft, destructive actions, broad internet scanning, or exploitation of third-party systems.
- Do not bypass user approval requirements for high-impact actions.
- If a path would create harm or exceed scope, stop and document the safer validation route.
