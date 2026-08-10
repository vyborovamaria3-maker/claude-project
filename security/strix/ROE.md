# Strix Rules of Engagement

## Authorization

This assessment is authorized only for assets owned and controlled by the `dima09090/claude-project` project.

## Default mode

The default scan is **source-only white-box**. It must not send active exploit traffic to production systems.

## In scope

- `solana-launcher/`
- `solana-launcher/backend/`
- `admin-site/`
- `memecoin-intelligence/`
- Telegram Intelligence code and configuration inside the repository
- Dockerfiles, Compose files, Nginx, CI/CD, migrations, dependency manifests and security configuration

## Out of scope unless explicitly enabled for a staging run

- Production `potapoff.fun`
- `89.125.121.60`
- third-party Telegram infrastructure
- X/Twitter infrastructure
- Apify infrastructure
- public Solana RPC providers
- Helius infrastructure
- external package registries beyond passive dependency/advisory checks

## Prohibited actions

- denial-of-service or load/stress testing
- credential theft or session hijacking
- persistence, stealth or destructive post-exploitation
- deletion or corruption of production data
- sending real-money blockchain transactions
- brute forcing real accounts
- testing third-party assets without separate authorization
- exfiltrating real secrets or personal data

## Allowed validation

For source-only scans Strix may:

- inspect source, configuration and dependency manifests
- build local test harnesses inside its sandbox
- create non-destructive local PoCs
- reason about reachable attack paths
- validate findings against local/stub services created inside the scan sandbox

For a future staging-only grey-box scan, active requests are allowed only against the explicitly named staging URL and test accounts.

## Finding acceptance gate

A candidate is not considered confirmed until the report contains:

1. affected component and file/line where applicable;
2. attacker-controlled source;
3. vulnerable sink or broken security invariant;
4. required privileges/preconditions;
5. safe reproduction steps or local PoC;
6. demonstrated impact;
7. confidence and severity rationale;
8. false-positive analysis;
9. recommended regression test.

## Reporting classes

- `CONFIRMED`
- `NEEDS_VERIFICATION`
- `HARDENING`
- `FALSE_POSITIVE`
- `RISK_ACCEPTED`

Do not merge code fixes automatically during audit runs. Remediation is a separate, one-finding-at-a-time workflow.