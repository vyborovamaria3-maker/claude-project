\\set ON_ERROR_STOP on
\\getenv bootstrap_user PGUSER
\\getenv app_user POSTGRES_APP_USER
\\getenv app_password POSTGRES_APP_PASSWORD
\\getenv migrator_user POSTGRES_MIGRATOR_USER
\\getenv migrator_password POSTGRES_MIGRATOR_PASSWORD
\\getenv readonly_user POSTGRES_READONLY_USER
\\getenv readonly_password POSTGRES_READONLY_PASSWORD
SELECT current_database() AS current_db \\gset
SELECT current_user IN (:'app_user', :'migrator_user', :'readonly_user') AS unsafe_bootstrap \\gset
\\if :unsafe_bootstrap
\\echo 'Refusing to provision roles while connected as a restricted application role'
\\quit 3
\\endif
SELECT count(DISTINCT role_name)=3 AS unique_role_names
FROM (VALUES (:'app_user'), (:'migrator_user'), (:'readonly_user')) AS roles(role_name) \\gset
\\if :unique_role_names
\\else
\\echo 'Application, migration and read-only role names must be distinct'
\\quit 3
\\endif
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') AS app_role_exists \\gset
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_user') AS migrator_role_exists \\gset
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'readonly_user') AS readonly_role_exists \\gset

\\if :app_role_exists
ALTER ROLE :"app_user"
  WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\\else
CREATE ROLE :"app_user"
  WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\\endif

\\if :migrator_role_exists
ALTER ROLE :"migrator_user"
  WITH LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\\else
CREATE ROLE :"migrator_user"
  WITH LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\\endif

\\if :readonly_role_exists
ALTER ROLE :"readonly_user"
  WITH LOGIN PASSWORD :'readonly_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\\else
CREATE ROLE :"readonly_user"
  WITH LOGIN PASSWORD :'readonly_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\\endif

-- Keep the restricted identities from inheriting or switching into any role.
SELECT format('REVOKE %I FROM %I', parent_role.rolname, member_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles parent_role ON parent_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE member_role.rolname IN (:'app_user', :'migrator_user', :'readonly_user') \\gexec

-- The read-only role must never own application objects.
REASSIGN OWNED BY :"readonly_user" TO :"bootstrap_user";

REVOKE ALL PRIVILEGES ON DATABASE :"current_db" FROM :"app_user", :"migrator_user", :"readonly_user";
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
