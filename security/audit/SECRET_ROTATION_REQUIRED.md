# Required credential rotation

Multiple credentials were found committed in repository content/history during security audits. Their literal values are intentionally not reproduced here.

## 1. Telegram bot credential — SEC-012

Status: **ROTATION REQUIRED**

1. Revoke/regenerate the affected bot token in Telegram BotFather.
2. Store the replacement token only in the deployment secret store / environment (`BOT_TOKEN` or the service-specific `TELEGRAM_BOT_TOKEN`).
3. Redeploy every bot/API process that uses the token.
4. Verify the replacement token works.
5. Verify the exposed old token no longer authenticates.
6. Review Telegram webhook configuration after rotation and re-register it if the deployment requires it.
7. Never paste the replacement token into Git, PR comments, CI logs, tickets, screenshots, or audit reports.

## 2. External custom API credential — SEC-013

Status: **ROTATION REQUIRED**

1. Revoke the exposed `sk-`-prefixed credential at the custom API provider that issued it.
2. Generate a replacement credential with the minimum permissions needed.
3. Store it only in the appropriate user/deployment secret store.
4. Redeploy/reconfigure the consumer if the credential is still needed.
5. Verify the old credential is disabled.
6. Review provider-side usage/audit logs for unexpected activity during the exposure window.

## 3. JWT-style external API credential — 2026-09-06 full-repo audit

Status: **ROTATION REQUIRED**

A JWT-like credential was found literally prepended to `pumpfun-chart/backend/candle-aggregator.js`. It has been removed from the current source tree. Because it was committed, deletion alone does not make the credential safe.

1. Identify the service/provider that issued the token from deployment/provider records; do not paste the token into tickets or chat while investigating.
2. Revoke/rotate the affected token at the provider.
3. Store any replacement only in a secret store or untracked runtime environment.
4. Review provider-side usage/audit logs for suspicious activity during the exposure window.
5. Verify the old token can no longer authenticate.
6. Purge historical copies from Git history during the coordinated history-cleanup operation described below.

## 4. Historical Supabase service-role-style credential

Status: **ROTATION / VERIFICATION REQUIRED IF IT WAS REAL**

A previous audit found a service-role-style Supabase credential in tracked repository content. The current tree is clean, but source deletion cannot prove provider-side revocation.

1. Confirm the affected Supabase project/key from provider records.
2. Revoke/rotate the historical key if it ever authenticated to a real project.
3. Update deployment secrets with the replacement where still required.
4. Verify the old key no longer authenticates.
5. Include the value in the coordinated Git history purge without recording the literal secret in this file.

## Git history

The current tracked files have been cleaned. Historical copies can remain retrievable from git history even after deletion from the current branch, so **provider-side revocation is mandatory**.

If repository-history rewriting is desired, coordinate it as a separate maintenance operation because it rewrites commit IDs and requires collaborators/deployments to re-clone or carefully reset. Do not treat history rewriting as a replacement for credential rotation.

## Verification record

Do not record secret values here. Record only safe metadata such as:

- rotation date/time;
- credential type/provider;
- affected service name;
- deployment successfully restarted;
- old credential verified invalid;
- operator/reviewer identifier.
