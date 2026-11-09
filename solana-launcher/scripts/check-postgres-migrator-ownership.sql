\set ON_ERROR_STOP on
\pset pager off

SELECT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'migrator_user'
) AS migrator_exists \gset
\if :migrator_exists
\else
  \echo 'Migration role is missing; role provisioning must run first'
  \quit 3
\endif

-- A schema CREATE grant is not enough to ALTER legacy objects. Require every
-- non-extension application relation, routine and user-defined type to be
-- owned by the migrator. Extension members are excluded and must be reviewed
-- separately; no ownership is changed by this check.
WITH extension_members AS (
  SELECT classid, objid
  FROM pg_depend
  WHERE deptype = 'e'
),
application_objects AS (
  SELECT
    'relation'::text AS object_kind,
    n.nspname || '.' || c.relname AS object_name,
    c.relowner AS owner_oid
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

  SELECT
    'routine'::text,
    n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    p.proowner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND NOT EXISTS (
      SELECT 1 FROM extension_members e
      WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid
    )

  UNION ALL

  SELECT
    'type'::text,
    n.nspname || '.' || t.typname,
    t.typowner
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND t.typtype IN ('d', 'e', 'r', 'm')
    AND NOT EXISTS (
      SELECT 1 FROM extension_members e
      WHERE e.classid = 'pg_type'::regclass AND e.objid = t.oid
    )
),
migrator AS (
  SELECT oid FROM pg_roles WHERE rolname = :'migrator_user'
)
WITH extension_members AS (
  SELECT classid, objid FROM pg_depend WHERE deptype = 'e'
),
unsupported_application_schemas AS (
  SELECT n.oid, n.nspname
  FROM pg_namespace n
  WHERE n.nspname <> 'public'
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND (
      EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.relnamespace = n.oid
          AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
          AND NOT EXISTS (
            SELECT 1 FROM extension_members e
            WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid
          )
      )
      OR EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.pronamespace = n.oid
          AND NOT EXISTS (
            SELECT 1 FROM extension_members e
            WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid
          )
      )
      OR EXISTS (
        SELECT 1 FROM pg_type t
        WHERE t.typnamespace = n.oid
          AND t.typtype IN ('d', 'e', 'r', 'm')
          AND NOT EXISTS (
            SELECT 1 FROM extension_members e
            WHERE e.classid = 'pg_type'::regclass AND e.objid = t.oid
          )
      )
    )
)
SELECT count(*)::integer AS unsupported_application_schema_count
FROM unsupported_application_schemas \\gset

\\if :unsupported_application_schema_count
  \\echo 'Production migration blocked: non-public application schema requires separately reviewed grants and default privileges'
  \\quit 3
\\endif

SELECT count(*)::integer AS non_migrator_object_count
FROM application_objects, migrator
WHERE application_objects.owner_oid <> migrator.oid \gset

\if :non_migrator_object_count
  \echo 'Production migration blocked: non-extension application objects are not owned by the migration role.'
  \echo 'Run the catalog inventory, review an explicit object-level ownership allowlist, and rehearse forward/rollback on an isolated restore.'
  \echo 'This guard is read-only and does not execute REASSIGN OWNED or alter database objects.'
  \quit 3
\endif

SELECT count(*)::integer AS missing_restricted_roles
FROM (VALUES (:'app_user'), (:'backup_user'), (:'readonly_user')) AS restricted(role_name)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = restricted.role_name) \gset
\if :missing_restricted_roles
  \echo 'Production migration blocked: app, backup or read-only role is missing'
  \quit 3
\endif

SELECT count(*)::integer AS restricted_database_create_count
FROM (VALUES (:'app_user'), (:'backup_user'), (:'readonly_user')) AS restricted(role_name)
WHERE has_database_privilege(restricted.role_name, current_database(), 'CREATE') \gset
\if :restricted_database_create_count
  \echo 'Production migration blocked: runtime, backup or read-only role has database CREATE'
  \quit 3
\endif
SELECT has_database_privilege(:'migrator_user', current_database(), 'CREATE') AS migrator_can_create_database \gset
\if :migrator_can_create_database
  \echo 'Production migration blocked: migration role must not have database CREATE'
  \quit 3
\endif

SELECT count(*)::integer AS app_schemas_without_create
FROM pg_namespace n
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
  AND (
    EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.relnamespace = n.oid
        AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
        )
    )
    OR EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.pronamespace = n.oid
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        )
    )
    OR EXISTS (
      SELECT 1 FROM pg_type t
      WHERE t.typnamespace = n.oid
        AND t.typtype IN ('d', 'e', 'r', 'm')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
        )
    )
  )
  AND NOT has_schema_privilege(:'migrator_user', n.oid, 'CREATE') \gset

\if :app_schemas_without_create
  \echo 'Production migration blocked: migration role lacks CREATE on an application schema'
  \quit 3
\endif
WITH application_schemas AS (
  SELECT DISTINCT n.oid
  FROM pg_namespace n
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg_%'
    AND (
      EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.relnamespace = n.oid
          AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
          )
      )
      OR EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.pronamespace = n.oid
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          )
      )
      OR EXISTS (
        SELECT 1 FROM pg_type t
        WHERE t.typnamespace = n.oid
          AND t.typtype IN ('d', 'e', 'r', 'm')
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
          )
      )
    )
)
SELECT count(*)::integer AS restricted_schemas_with_create
FROM application_schemas n
WHERE has_schema_privilege(:'app_user', n.oid, 'CREATE')
   OR has_schema_privilege(:'backup_user', n.oid, 'CREATE')
   OR has_schema_privilege(:'readonly_user', n.oid, 'CREATE') \gset

\if :restricted_schemas_with_create
  \echo 'Production migration blocked: runtime, backup or read-only role has CREATE on an application schema'
  \quit 3
\endif

SELECT has_schema_privilege(:'migrator_user', 'public', 'CREATE') AS migrator_can_create \gset
\if :migrator_can_create
\else
  \echo 'Production migration blocked: migration role lacks CREATE on public schema'
  \quit 3
\endif

\echo 'POSTGRES_MIGRATOR_OWNERSHIP_OK objects=owned schema_create=true'
