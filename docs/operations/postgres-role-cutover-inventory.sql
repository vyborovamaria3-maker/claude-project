-- PostgreSQL 16/17: catalog-only inventory for a reviewed role cutover.
-- NO table rows, password hashes or secret values. Operator-only output may
-- still contain sensitive role/object metadata; store with restricted access.
-- Run via: psql -X -v ON_ERROR_STOP=1 -h <host> -U <audit_login> -d <db> -f docs/operations/postgres-role-cutover-inventory.sql
-- Must run as a read-only audit login and must NOT be a substitute for
-- collecting an approved, restorable backup and a rollback ownership map.
\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo 'IDENTITY AND DATABASE OWNER'
SELECT current_database() AS db_name, session_user AS login_name,
       current_user AS effective_role, current_setting('server_version') AS pg_version,
       pg_get_userbyid(d.datdba) AS db_owner, d.datacl::text AS database_acl
FROM pg_database d WHERE d.datname = current_database();

\echo 'LOGIN ROLE FLAGS AND MEMBERSHIPS'
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
       rolbypassrls, rolinherit, rolcanlogin
FROM pg_roles
WHERE rolcanlogin
ORDER BY rolname;
SELECT member.rolname AS member_role, parent.rolname AS parent_role,
       m.admin_option, m.inherit_option, m.set_option
FROM pg_auth_members m
JOIN pg_roles member ON member.oid=m.member
JOIN pg_roles parent ON parent.oid=m.roleid
ORDER BY member_role, parent_role;

\echo 'APPLICATION SCHEMAS AND ACL'
SELECT n.nspname AS schema_name, pg_get_userbyid(n.nspowner) AS owner_name,
       n.nspacl::text AS schema_acl,
       has_schema_privilege(current_user,n.oid,'USAGE') AS audit_can_use,
       has_schema_privilege(current_user,n.oid,'CREATE') AS audit_can_create
FROM pg_namespace n
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY n.nspname;

\echo 'OWNED RELATIONS: tables, views, matviews, sequences, partitions, foreign tables'
SELECT n.nspname AS schema_name, c.relname AS object_name,
       c.relkind AS object_kind, pg_get_userbyid(c.relowner) AS owner_name,
       c.relacl::text AS object_acl, c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       c.relpersistence AS persistence
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
  AND c.relkind IN ('r','p','v','m','S','f')
ORDER BY n.nspname,c.relkind,c.relname;

\echo 'FUNCTIONS / PROCEDURES AND SECURITY DEFINER'
SELECT n.nspname AS schema_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
       p.prokind AS routine_kind, pg_get_userbyid(p.proowner) AS owner_name,
       p.prosecdef AS security_definer, p.proacl::text AS routine_acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY n.nspname,object_name;

\echo 'USER-DEFINED TYPES, DOMAINS AND ENUMS'
SELECT n.nspname AS schema_name,t.typname AS object_name,
       t.typtype AS type_kind,pg_get_userbyid(t.typowner) AS owner_name,
       t.typacl::text AS type_acl
FROM pg_type t
JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
  AND t.typtype IN ('d','e','r','m')
ORDER BY n.nspname,t.typname;

\echo 'EXTENSIONS: review before ownership transfer'
SELECT e.extname, e.extversion, n.nspname AS extension_schema,
       pg_get_userbyid(e.extowner) AS extension_owner
FROM pg_extension e
JOIN pg_namespace n ON n.oid=e.extnamespace
ORDER BY e.extname;

\echo 'ROW-LEVEL SECURITY POLICIES: policy definitions require separate review'
SELECT n.nspname AS schema_name,c.relname AS table_name,
       p.polname AS policy_name,p.polcmd AS command,p.polpermissive,
       p.polroles::text AS applicable_role_oids,
       p.polqual IS NOT NULL AS has_using_expression,
       p.polwithcheck IS NOT NULL AS has_check_expression
FROM pg_policy p
JOIN pg_class c ON c.oid=p.polrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY n.nspname,c.relname,p.polname;

\echo 'DEFAULT PRIVILEGES BY ORIGINAL OBJECT CREATOR'
SELECT pg_get_userbyid(d.defaclrole) AS original_creator,
       COALESCE(n.nspname,'<all schemas>') AS schema_name,
       d.defaclobjtype AS object_kind,d.defaclacl::text AS default_acl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
ORDER BY original_creator,schema_name,object_kind;

\echo 'FOREIGN SERVER METADATA (no credentials/options)'
SELECT s.srvname,pg_get_userbyid(s.srvowner) AS server_owner,
       fdw.fdwname AS foreign_data_wrapper
FROM pg_foreign_server s
JOIN pg_foreign_data_wrapper fdw ON fdw.oid=s.srvfdw
ORDER BY s.srvname;

COMMIT;
\echo 'ROLE CUTOVER INVENTORY COMPLETE: read-only metadata, no changes'
