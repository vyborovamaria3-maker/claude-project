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

SELECT (
  :'app_password' <> :'migrator_password'
  AND :'app_password' <> :'backup_password'
  AND :'app_password' <> :'readonly_password'
  AND :'migrator_password' <> :'backup_password'
  AND :'migrator_password' <> :'readonly_password'
  AND :'backup_password' <> :'readonly_password'
) AS passwords_distinct \gset
\if :passwords_distinct
\else
  \echo 'App, migrator, backup and read-only passwords must be distinct'
  \quit 3
\endif

-- All deployment preconditions that can be checked without writes must
-- pass before changing passwords, role flags, memberships or ACLs.
SELECT COALESCE((
  SELECT pg_get_userbyid(datdba) = :'bootstrap_user'
  FROM pg_database WHERE datname = current_database()
), false) AS bootstrap_owns_database \gset
\if :bootstrap_owns_database
\else
  \echo 'Role provisioning blocked: database owner must remain the configured bootstrap identity'
  \quit 3
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
  WHERE n.nspname <> 'public'
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND acl.grantee = 0
    AND acl.privilege_type = 'CREATE'
) AS has_public_nonpublic_schema_create \gset
\if :has_public_nonpublic_schema_create
  \echo 'Role provisioning blocked: PUBLIC CREATE on a non-public schema requires explicit operator review'
  \quit 3
\endif

WITH extension_members AS (
  SELECT classid, objid FROM pg_depend WHERE deptype = 'e'
),
application_objects AS (
  SELECT n.nspname AS schema_name, c.relowner AS owner_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    AND NOT EXISTS (
      SELECT 1 FROM extension_members e
      WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid
    )
  UNION ALL
  SELECT n.nspname, p.proowner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND NOT EXISTS (
      SELECT 1 FROM extension_members e
      WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid
    )
  UNION ALL
  SELECT n.nspname, t.typowner
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND t.typtype IN ('b', 'c', 'd', 'e', 'm', 'p', 'r')
    AND NOT EXISTS (
      SELECT 1 FROM extension_members e
      WHERE e.classid = 'pg_type'::regclass AND e.objid = t.oid
    )
)
SELECT EXISTS (
  SELECT 1 FROM application_objects
  WHERE schema_name <> 'public'
     OR pg_get_userbyid(owner_oid) IS DISTINCT FROM :'migrator_user'
) AS has_unprepared_application_owners \gset
\if :has_unprepared_application_owners
  \echo 'Role provisioning blocked: application objects require a separately reviewed migration-owner allowlist'
  \quit 3
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND p.prosecdef
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend e
      WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e'
    )
) AS has_public_security_definer_execute \gset
\if :has_public_security_definer_execute
  \echo 'Role provisioning blocked: SECURITY DEFINER function is executable by PUBLIC'
  \quit 3
\endif

SELECT EXISTS (
  SELECT 1 FROM pg_largeobject_metadata lom
  WHERE pg_get_userbyid(lom.lomowner) IS DISTINCT FROM :'migrator_user'
) AS has_unprepared_large_objects \gset
\if :has_unprepared_large_objects
  \echo 'Role provisioning blocked: large objects require a separately reviewed migration-owner allowlist'
  \quit 3
\endif

BEGIN;

-- Dedicated application, migration, backup and read-only roles. None inherits
-- privileges from another role; backup is not allowed to bypass row security. None inherits
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
WHERE member.rolname IN (:'app_user', :'migrator_user', :'backup_user', :'readonly_user')
   OR granted.rolname IN (:'app_user', :'migrator_user', :'backup_user', :'readonly_user') \gexec

-- No blanket REASSIGN OWNED and no automatic database/schema ownership change.
-- Existing application-object ownership is a separately reviewed allowlist
-- cutover; deploy-production.sh checks it before running Alembic.
SELECT format('REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- Keep DDL out of runtime, backup and read-only identities even if stale
-- explicit grants existed before this provisioner was introduced.
SELECT format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM %I', current_database(), role_name)
FROM (VALUES (:'app_user'), (:'migrator_user'), (:'backup_user'), (:'readonly_user')) AS roles(role_name) \gexec
SELECT format('REVOKE CREATE ON SCHEMA %I FROM %I', n.nspname, role_name)
FROM pg_namespace n
CROSS JOIN (VALUES (:'app_user'), (:'backup_user'), (:'readonly_user')) AS roles(role_name)
WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%' \gexec
SELECT format('REVOKE CREATE ON SCHEMA %I FROM %I', n.nspname, :'migrator_user')
FROM pg_namespace n
WHERE n.nspname <> 'public'
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%' \gexec
GRANT USAGE, CREATE ON SCHEMA public TO :"migrator_user";
GRANT USAGE ON SCHEMA public TO :"app_user", :"backup_user", :"readonly_user";

-- Remove stale PUBLIC data access before applying the explicit role grants.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

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
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC', :'migrator_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC', :'migrator_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', :'migrator_user') \gexec

ALTER ROLE :"backup_user" SET default_transaction_read_only = on;
ALTER ROLE :"readonly_user" SET default_transaction_read_only = on;
ALTER ROLE :"app_user" RESET default_transaction_read_only;
ALTER ROLE :"migrator_user" RESET default_transaction_read_only;

COMMIT;
