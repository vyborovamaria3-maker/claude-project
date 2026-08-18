# Required credential rotation

Two credentials were found committed in repository content/history during the 2026-08-18 audit. Their literal values are intentionally not reproduced here.

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

## Git history

The current tracked files have been cleaned. Historical copies can remain retrievable from git history even after deletion from the current branch, so **provider-side revocation is mandatory**.

If repository-history rewriting is desired later, coordinate it as a separate maintenance operation because it rewrites commit IDs and requires collaborators/deployments to re-clone or carefully reset. Do not treat history rewriting as a replacement for credential rotation.

## Verification record

Do not record secret values here. Record only safe metadata such as:

- rotation date/time;
- credential type/provider;
- affected service name;
- deployment successfully restarted;
- old credential verified invalid;
- operator/reviewer identifier.
