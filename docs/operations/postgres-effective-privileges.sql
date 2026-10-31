\pset pager off
\echo 'DATABASE IDENTITY'
SELECT current_database() AS database_name,
       current_user AS effective_role,
       session_user AS login_role,
       current_setting('default_transaction_read_only') AS default_transaction_read_only;

\echo 'CURRENT ROLE ATTRIBUTES'
SELECT rolname,
       rolcanlogin,
       rolsuper,
       rolinherit,
       rolcreatedb,
       rolcreaterole,
       rolreplication,
       rolbypassrls
FROM pg_roles
WHERE rolname = current_user;

\echo 'INHERITED ROLE MEMBERSHIPS'
SELECT parent.rolname AS inherited_role,
       pg_has_role(current_user, parent.rolname, 'MEMBER') AS is_member,
       pg_has_role(current_user, parent.rolname, 'USAGE') AS privileges_inherited_without_set_role
FROM pg_roles AS parent
WHERE parent.rolname <> current_user
  AND pg_has_role(current_user, parent.rolname, 'MEMBER')
ORDER BY parent.rolname;

\echo 'EFFECTIVE DATABASE PRIVILEGES'
SELECT current_database() AS database_name,
       has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
       has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temp_objects;

\echo 'EFFECTIVE SCHEMA PRIVILEGES'
SELECT n.nspname AS schema_name,
       has_schema_privilege(current_user, n.oid, 'USAGE') AS can_use,
       has_schema_privilege(current_user, n.oid, 'CREATE') AS can_create
FROM pg_namespace AS n
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname;

\echo 'EFFECTIVE TABLE AND VIEW PRIVILEGES'
SELECT n.nspname AS schema_name,
       c.relname AS relation_name,
       c.relkind AS relation_kind,
       has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
       has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
       has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
       has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
       has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
       has_table_privilege(current_user, c.oid, 'REFERENCES') AS can_reference,
       has_table_privilege(current_user, c.oid, 'TRIGGER') AS can_create_trigger
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname;

\echo 'EFFECTIVE SEQUENCE PRIVILEGES'
SELECT n.nspname AS schema_name,
       s.relname AS sequence_name,
       has_sequence_privilege(current_user, s.oid, 'USAGE') AS can_use,
       has_sequence_privilege(current_user, s.oid, 'SELECT') AS can_select,
       has_sequence_privilege(current_user, s.oid, 'UPDATE') AS can_update
FROM pg_class AS s
JOIN pg_namespace AS n ON n.oid = s.relnamespace
WHERE s.relkind = 'S'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, s.relname;

\echo 'PUBLIC TABLE GRANTS'
SELECT table_schema,
       table_name,
       privilege_type,
       is_grantable
FROM information_schema.table_privileges
WHERE grantee = 'PUBLIC'
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, privilege_type;

\echo 'DEFAULT PRIVILEGES'
SELECT pg_get_userbyid(d.defaclrole) AS object_owner,
       COALESCE(n.nspname, '<all schemas>') AS schema_name,
       d.defaclobjtype AS object_type,
       d.defaclacl AS default_acl
FROM pg_default_acl AS d
LEFT JOIN pg_namespace AS n ON n.oid = d.defaclnamespace
ORDER BY object_owner, schema_name, object_type;

\echo 'AUDIT COMPLETE: this script did not change database state.'
