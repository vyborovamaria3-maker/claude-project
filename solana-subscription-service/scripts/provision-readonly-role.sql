\set ON_ERROR_STOP on
\getenv bootstrap_user PGUSER
\getenv readonly_user POSTGRES_READONLY_USER
\getenv readonly_password POSTGRES_READONLY_PASSWORD
SELECT current_database() AS current_db \gset
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'readonly_user') AS readonly_role_exists \gset

\if :readonly_role_exists
ALTER ROLE :"readonly_user"
  WITH LOGIN PASSWORD :'readonly_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\else
CREATE ROLE :"readonly_user"
  WITH LOGIN PASSWORD :'readonly_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
\endif

REASSIGN OWNED BY :"readonly_user" TO :"bootstrap_user";
SELECT format('REVOKE %I FROM %I', parent_role.rolname, member_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles parent_role ON parent_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE member_role.rolname = :'readonly_user' \gexec

REVOKE ALL PRIVILEGES ON DATABASE :"current_db" FROM :"readonly_user";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"readonly_user";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"readonly_user";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"readonly_user";

GRANT CONNECT ON DATABASE :"current_db" TO :"readonly_user";
GRANT USAGE ON SCHEMA public TO :"readonly_user";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"readonly_user";
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO :"readonly_user";

ALTER DEFAULT PRIVILEGES FOR ROLE :"bootstrap_user" IN SCHEMA public
  REVOKE ALL ON TABLES FROM :"readonly_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"bootstrap_user" IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM :"readonly_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"bootstrap_user" IN SCHEMA public
  GRANT SELECT ON TABLES TO :"readonly_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"bootstrap_user" IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO :"readonly_user";

ALTER ROLE :"readonly_user" IN DATABASE :"current_db"
  SET default_transaction_read_only = on;
ALTER ROLE :"readonly_user" IN DATABASE :"current_db"
  SET statement_timeout = '15s';
ALTER ROLE :"readonly_user" IN DATABASE :"current_db"
  SET idle_in_transaction_session_timeout = '15s';
