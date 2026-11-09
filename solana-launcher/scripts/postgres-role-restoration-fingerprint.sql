-- Stable, catalog-only role/ACL fingerprint for disconnected restore comparison.
-- This inventory contains NO table data, credentials, or password hashes.
-- Capture through psql -X -A -t -v ON_ERROR_STOP=1 -f this.sql.
-- Include database ACLs, app-role attributes/memberships and column ACLs:
-- pg_dumpall globals + pg_restore --create must restore these as well as
-- schema/relation/routine/default ACLs before recovery can be called complete.
SELECT kind || '|' || schema_name || '|' || object_name || '|' || owner_name || '|' || acl
FROM (
    SELECT 'database' AS kind,''::text AS schema_name,'<current>'::text AS object_name,
           pg_get_userbyid(d.datdba) AS owner_name,
           concat_ws(',',
             'allowconn=' || d.datallowconn::text,
             'connlimit=' || d.datconnlimit::text,
             'acl=' || CASE WHEN d.datacl IS NULL THEN '<default>'
                WHEN cardinality(d.datacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(d.datacl) AS x) END
           ) AS acl
      FROM pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT 'role','',r.rolname,''::text,
           concat_ws(',',
             'super=' || r.rolsuper::text,
             'inherit=' || r.rolinherit::text,
             'createdb=' || r.rolcreatedb::text,
             'createrole=' || r.rolcreaterole::text,
             'login=' || r.rolcanlogin::text,
             'replication=' || r.rolreplication::text,
             'bypassrls=' || r.rolbypassrls::text,
             'connlimit=' || r.rolconnlimit::text,
             'validuntil=' || COALESCE(r.rolvaliduntil::text,'<none>'),
             'config=' || COALESCE(array_to_json(r.rolconfig)::text,'<none>')
           )
      FROM pg_roles r WHERE r.rolname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'membership','',
           member.rolname || '->' || granted.rolname,
           grantor.rolname,
           concat_ws(',',
             'admin=' || m.admin_option::text,
             'inherit=' || m.inherit_option::text,
             'set=' || m.set_option::text
           )
      FROM pg_auth_members m
      JOIN pg_roles granted ON granted.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
      JOIN pg_roles grantor ON grantor.oid = m.grantor
     WHERE member.rolname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'schema',n.nspname,''::text,
           pg_get_userbyid(n.nspowner),
           CASE WHEN n.nspacl IS NULL THEN '<default>'
                WHEN cardinality(n.nspacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(n.nspacl) AS x) END
      FROM pg_namespace n WHERE n.nspname <> 'information_schema'
       AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'relation',n.nspname,c.relname || ':' || c.relkind::text,
           pg_get_userbyid(c.relowner),
           CASE WHEN c.relacl IS NULL THEN '<default>'
                WHEN cardinality(c.relacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(c.relacl) AS x) END
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
       AND c.relkind IN ('r','p','S','v','m','f')
    UNION ALL
    SELECT 'column',n.nspname,c.relname || '.' || a.attname,
           pg_get_userbyid(c.relowner),
           CASE WHEN cardinality(a.attacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(a.attacl) AS x) END
      FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
       AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'routine',n.nspname,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_get_userbyid(p.proowner),
           CASE WHEN p.proacl IS NULL THEN '<default>'
                WHEN cardinality(p.proacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(p.proacl) AS x) END
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'type',n.nspname,t.typname,
           pg_get_userbyid(t.typowner),
           CASE WHEN t.typacl IS NULL THEN '<default>'
                WHEN cardinality(t.typacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(t.typacl) AS x) END
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'large-object','',lom.oid::text,
           pg_get_userbyid(lom.lomowner),
           CASE WHEN lom.lomacl IS NULL THEN '<default>'
                WHEN cardinality(lom.lomacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(lom.lomacl) AS x) END
      FROM pg_largeobject_metadata lom
    UNION ALL
    SELECT 'default-acl',COALESCE(n.nspname,'<all>'),d.defaclobjtype::text,
           pg_get_userbyid(d.defaclrole),
           CASE WHEN d.defaclacl IS NULL THEN '<default>'
                WHEN cardinality(d.defaclacl)=0 THEN '<empty>'
                ELSE (SELECT string_agg(x::text,',' ORDER BY x::text)
                      FROM unnest(d.defaclacl) AS x) END
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
) inventory
ORDER BY kind,schema_name,object_name,owner_name,acl;
