\set ON_ERROR_STOP on

-- This provisioner may only run as the configured bootstrap superuser.
SELECT COALESCE((
  SELECT rolsuper
  FROM pg_roles
  WHERE rolname = current_user
    AND rolname = :'bootstrap_user'
), false) AS bootstrap_is_superuser \gset
\if :bootstrap_is_superuser
\else
  \echo 'Role provisioning requires the configured bootstrap superuser'
  \quit 3
\endif

SELECT (
  :'app_user' <> :'migrator_user'
  AND :'app_user' <> :'backup_user'
  AND :'app_user' <> :'readonly_user'
  AND :'migrator_user' <> :'backup_user'
  AND :'migrator_user' <> :'readonly_user'
  AND :'backup_user' <> :'readonly_user'
  AND :'app_user' <> :'bootstrap_user'
  AND :'migrator_user' <> :'bootstrap_user'
  AND :'backup_user' <> :'bootstrap_user'
  AND :'readonly_user' <> :'bootstrap_user'
) AS role_names_distinct \gset
\if :role_names_distinct
\else
  \echo 'Bootstrap, app, migrator, backup and read-only identities must be distinct'
  \quit 3
\endif

BEGIN;

-- Dedicated application, migration, backup and read-only roles. None inherits
-- privileges from another role; backup is not allowed to bypass row security.
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'app_user', :'app_password') \gexec

SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'migrator_user', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'migrator_user', :'migrator_password') \gexec

SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'backup_user', :'backup_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'backup_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'backup_user', :'backup_password') \gexec

SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'readonly_user', :'readonly_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'readonly_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'readonly_user', :'readonly_password') \gexec

-- Remove any stale memberships from earlier configurations. The restricted
-- identities must not inherit pg_read_all_data or any other elevated role.
SELECT format('REVOKE %I FROM %I', granted.rolname, member.rolname)
FROM pg_auth_members m
JOIN pg_roles granted ON granted.oid = m.roleid
JOIN pg_roles member ON member.oid = m.member
WHERE member.rolname IN (:'app_user', :'migrator_user', :'backup_user', :'readonly_user') \gexec

-- No blanket REASSIGN OWNED and no automatic database/schema ownership change.
-- Existing application-object ownership is a separately reviewed allowlist
-- cutover; deploy-production.sh checks it before running Alembic.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"migrator_user";
GRANT USAGE ON SCHEMA public TO :"app_user", :"backup_user", :"readonly_user";

SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I, %I, %I', current_database(), :'app_user', :'migrator_user', :'backup_user', :'readonly_user') \gexec
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"backup_user", :"readonly_user";
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO :"backup_user", :"readonly_user";

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migrator_user', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'migrator_user', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I', :'migrator_user', :'backup_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I', :'migrator_user', :'backup_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I', :'migrator_user', :'readonly_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I', :'migrator_user', :'readonly_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', :'migrator_user') \gexec

ALTER ROLE :"backup_user" SET default_transaction_read_only = on;
ALTER ROLE :"readonly_user" SET default_transaction_read_only = on;
ALTER ROLE :"app_user" RESET default_transaction_read_only;
ALTER ROLE :"migrator_user" RESET default_transaction_read_only;

COMMIT;
