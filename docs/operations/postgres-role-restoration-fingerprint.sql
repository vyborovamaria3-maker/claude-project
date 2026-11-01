-- Stable, catalog-only role/ACL fingerprint for disconnected restore comparison.
-- This inventory contains NO table data, credentials, or password hashes.
-- Capture through psql -X -A -t -v ON_ERROR_STOP=1 -f this.sql
SELECT kind || '|' || schema_name || '|' || object_name || '|' || owner_name || '|' || acl
FROM (
    SELECT 'schema' AS kind,n.nspname AS schema_name,''::text AS object_name,
           pg_get_userbyid(n.nspowner) AS owner_name,
           COALESCE((SELECT string_agg(x::text,',' ORDER BY x::text)
                     FROM unnest(n.nspacl) AS x),'') AS acl
      FROM pg_namespace n WHERE n.nspname <> 'information_schema'
       AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'relation',n.nspname,c.relname || ':' || c.relkind,
           pg_get_userbyid(c.relowner),
           COALESCE((SELECT string_agg(x::text,',' ORDER BY x::text)
                     FROM unnest(c.relacl) AS x),'')
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
       AND c.relkind IN ('r','p','S','v','m','f')
    UNION ALL
    SELECT 'routine',n.nspname,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_get_userbyid(p.proowner),
           COALESCE((SELECT string_agg(x::text,',' ORDER BY x::text)
                     FROM unnest(p.proacl) AS x),'')
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
    UNION ALL
    SELECT 'default-acl',COALESCE(n.nspname,'<all>'),d.defaclobjtype::text,
           pg_get_userbyid(d.defaclrole),
           COALESCE((SELECT string_agg(x::text,',' ORDER BY x::text)
                     FROM unnest(d.defaclacl) AS x),'')
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
) inventory
ORDER BY kind,schema_name,object_name,owner_name,acl;
