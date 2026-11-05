# X Collector editor mutation policy

## Scope

The Control Center may inspect the dedicated X Collector PostgreSQL database through
`ADMIN_X_COLLECTOR_DSN`. This editor is not a general-purpose database console.
Read access and mutation access are intentionally separate.

## Allowed mutations

Only `public.feature_flags` has an application-level mutation allowlist:

| Operation | Allowed columns | Notes |
| --- | --- | --- |
| INSERT | `name`, `enabled`, `rollout_pct`, `description` | `updated_at` is assigned by the API; `payload` is deliberately excluded |
| UPDATE | `enabled`, `rollout_pct`, `description` | `updated_at` is assigned by the API; primary key `name` cannot be changed |
| DELETE | None | Delete is disabled |

Every other table and view is read-only through this editor. This includes source
observations, tweets, token links, accounts and sessions, proxies, task queues,
DLQ, both outbox families, raw evidence, analytics, retention policies,
`schema_migrations`, ordinary views and materialized views.

The policy is enforced by the API, not only by hiding controls in the browser.
The table metadata exposes `allowed_actions` and per-column `editable_actions`;
mutation requests are rejected unless the table, operation and every submitted
column are explicitly allowlisted.

## Existing safeguards retained

- Administrator authentication and the existing Origin/MFA/re-auth middleware.
- Explicit confirmation for each mutation.
- Full primary key and `xmin` version match for updates.
- Sensitive-column masking and nested-secret checks.
- Audit record after the database transaction succeeds; failed operations are
  recorded as failures.

## Database role requirements

The application allowlist is defense in depth, not a replacement for PostgreSQL
least privilege. Before enabling the editor against any real database, an operator
must verify that the role used by `ADMIN_X_COLLECTOR_DSN` has:

- SELECT on the required collector tables/views;
- INSERT and UPDATE only on `public.feature_flags`;
- no DELETE/TRUNCATE or write access to source, queue, outbox, session, evidence
  or migration tables;
- no inherited membership or PUBLIC grants that reintroduce broader write access.

This change does not inspect or modify live database grants. If the existing
collector-admin role has broader privileges, that must be corrected through a
separately reviewed operator procedure before production use.

## Verification

Regression coverage lives in `admin-site/tests/test_x_collector_admin.py` and
covers read-only tables, denied delete, denied unlisted JSON payload, secret and
redaction handling, stale-row conflict, audit success/failure and SQL identifier
injection.
