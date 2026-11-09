-- Legacy filename retained for compatibility: this provisions app, migrator and read-only roles.
-- The bootstrap login is supplied by the container-side entrypoint and must not
-- be any of the restricted identities created below.
\set ON_ERROR_STOP on
\getenv bootstrap_user PGUSER
\getenv app_user POSTGRES_APP_USER
\getenv app_password POSTGRES_APP_PASSWORD
\getenv migrator_user POSTGRES_MIGRATOR_USER
\getenv migrator_password POSTGRES_MIGRATOR_PASSWORD
\getenv readonly_user POSTGRES_READONLY_USER
\getenv readonly_password POSTGRES_READONLY_PASSWORD
SELECT current_database() AS current_db \gset
SELECT current_user IN (:'app_user', :'migrator_user', :'readonly_user') AS unsafe_bootstrap \gset
\if :unsafe_bootstrap
\echo 'Refusing to provision roles while connected as a restricted application role'
\quit 3
\endif
SELECT count(DISTINCT role_name)=3 AS unique_role_names
FROM (VALUES (:'app_user'), (:'migrator_user'), (:'readonly_user')) AS roles(role_name) \gset
\if :unique_role_names
\else
\echo 'Application, migration and read-only role names must be distinct'
\quit 3
\endif

SELECT COALESCE((
  SELECT pg_get_userbyid(datdba) = :'bootstrap_user'
  FROM pg_database WHERE datname = current_database()
), false) AS bootstrap_owns_database \gset
\if :bootstrap_owns_database
\else
\echo 'Provisioning blocked: database owner must remain the configured bootstrap identity'
\quit 3
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_auth_members membership
  JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE granted_role.rolname IN (:'app_user', :'migrator_user', :'readonly_user')
     OR member_role.rolname IN (:'app_user', :'migrator_user', :'readonly_user')
) AS has_restricted_role_memberships \gset
\if :has_restricted_role_memberships
\echo 'Provisioning blocked: restricted role membership requires explicit operator review'
\quit 3
\endif

-- Existing application objects must already have a reviewed migration owner.
-- This is a read-only gate: never REASSIGN OWNED or ALTER object owners here.
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
\echo 'Provisioning blocked: application objects must be transferred through a separately reviewed object-level allowlist'
\quit 3
\endif

SELECT EXISTS (
  SELECT 1
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend e
      WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e'
    )
) AS has_public_security_definer_execute \gset
\if :has_public_security_definer_execute
\echo 'Provisioning blocked: SECURITY DEFINER function is executable by PUBLIC'
\quit 3
\endif

BEGIN;

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') AS app_role_exists \gset
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_user') AS migrator_role_exists \gset
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'readonly_user') AS readonly_role_exists \gset

\if :app_role_exists
ALTER ROLE :"app_user"
  WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\else
CREATE ROLE :"app_user"
  WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\endif

\if :migrator_role_exists
ALTER ROLE :"migrator_user"
  WITH LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\else
CREATE ROLE :"migrator_user"
  WITH LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\endif

\if :readonly_role_exists
ALTER ROLE :"readonly_user"
  WITH LOGIN PASSWORD :'readonly_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\else
CREATE ROLE :"readonly_user"
  WITH LOGIN PASSWORD :'readonly_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\endif

REVOKE ALL PRIVILEGES ON DATABASE :"current_db" FROM :"app_user", :"migrator_user", :"readonly_user";
-- PUBLIC membership grants apply even to NOINHERIT roles; remove legacy CREATE.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"app_user", :"migrator_user", :"readonly_user";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"app_user", :"migrator_user", :"readonly_user";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"app_user", :"migrator_user", :"readonly_user";

GRANT CONNECT ON DATABASE :"current_db" TO :"app_user", :"migrator_user", :"readonly_user";
GRANT USAGE ON SCHEMA public TO :"app_user", :"readonly_user";
GRANT USAGE, CREATE ON SCHEMA public TO :"migrator_user";

-- Runtime DML is deliberately separate from schema ownership and DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user", :"migrator_user";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user", :"migrator_user";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"readonly_user";
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO :"readonly_user";
GRANT USAGE ON ALL TYPES IN SCHEMA public TO :"app_user", :"migrator_user", :"readonly_user";

-- New objects created by the migration identity automatically grant only the
-- privileges required by runtime and read-only consumers.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_user" IN SCHEMA public
  REVOKE ALL ON TABLES FROM :"app_user", :"readonly_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_user" IN SCHEMA public
  GRANT SELECT ON TABLES TO :"readonly_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_user" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_user" IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO :"readonly_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_user" IN SCHEMA public
  GRANT USAGE ON TYPES TO :"app_user", :"readonly_user";

ALTER ROLE :"readonly_user" IN DATABASE :"current_db"
  SET default_transaction_read_only = on;
ALTER ROLE :"readonly_user" IN DATABASE :"current_db"
  SET statement_timeout = '15s';
ALTER ROLE :"readonly_user" IN DATABASE :"current_db"
  SET idle_in_transaction_session_timeout = '15s';

COMMIT;
