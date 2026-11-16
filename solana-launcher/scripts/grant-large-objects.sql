\set ON_ERROR_STOP on

-- Standalone large-object export grant step (review finding F3, issue #216).
--
-- The role provisioner stamps SELECT ON LARGE OBJECT grants only at
-- provisioning time, and PostgreSQL has no default-privileges mechanism for
-- large objects. A migrator-owned large object created after provisioning is
-- therefore invisible to a pg_dump run under the backup identity until the
-- export grants are refreshed. Run this script as part of every backup
-- cycle, immediately before the database dumps.
--
-- Required psql variables:
--   migrator_user  large-object owner. The caller must be this role or an
--                  explicitly authorized maintenance role that is a member
--                  of it (the grants are then executed under the migrator
--                  role itself, because only the large-object owner may
--                  grant privileges on large objects).
--   backup_user    export identity granted SELECT on every migrator-owned
--                  large object. Required.
--   readonly_user  second read-only export identity. Optional: pass an empty
--                  string for databases that provision no separate
--                  read-only identity.
--
-- The step grants nothing beyond SELECT on large objects and never modifies
-- role attributes, table privileges or ownership.

-- 1. Grantee sanity: export identities must differ from the migrator owner,
--    and the two export identities must differ from each other when both are
--    configured.
SELECT (
  :'backup_user' <> :'migrator_user'
  AND (
    :'readonly_user' = ''
    OR (:'readonly_user' <> :'backup_user' AND :'readonly_user' <> :'migrator_user')
  )
) AS grantee_names_valid \gset
\if :grantee_names_valid
\else
  \echo 'Large-object grant step requires the backup identity and the optional read-only identity to be distinct from the migrator owner and from each other'
  DO $$
BEGIN
  RAISE EXCEPTION 'Large-object grant preflight failed; see the diagnostic immediately above';
END
$$;
\endif

-- 2. Caller authorization. Grants are executed under the migrator role:
--    large-object privileges may only be granted by their owner.
SELECT (
  current_user = :'migrator_user'
  OR pg_has_role(current_user, :'migrator_user', 'MEMBER')
) AS caller_is_authorized \gset
\if :caller_is_authorized
\else
  \echo 'Large-object grants must run as the migrator identity (large-object owner) or as a maintenance role that is a member of it'
  DO $$
BEGIN
  RAISE EXCEPTION 'Large-object grant preflight failed; see the diagnostic immediately above';
END
$$;
\endif

SET ROLE :"migrator_user";

-- 3. Fail closed on large objects owned outside the migrator identity: their
--    contents can never be exported by the backup identity until an operator
--    reassigns or recreates them. This mirrors the provisioner's ownership
--    gate so post-provisioning drift cannot silently reappear.
SELECT EXISTS (
  SELECT 1 FROM pg_largeobject_metadata lom
  WHERE pg_get_userbyid(lom.lomowner) IS DISTINCT FROM :'migrator_user'
) AS has_foreign_large_objects \gset
\if :has_foreign_large_objects
  \echo 'Large objects owned outside the migrator identity block the export grant step; reassign or remove them first'
  DO $$
BEGIN
  RAISE EXCEPTION 'Large-object grant preflight failed; see the diagnostic immediately above';
END
$$;
\endif

-- 4. Grant read-only export access. GRANT is idempotent, so re-running this
--    step on every backup cycle is safe and never duplicates ACL entries.
SELECT format('GRANT SELECT ON LARGE OBJECT %s TO %I', l.oid, :'backup_user')
FROM pg_largeobject_metadata l
WHERE pg_get_userbyid(l.lomowner) = :'migrator_user'
\gexec

SELECT format('GRANT SELECT ON LARGE OBJECT %s TO %I', l.oid, :'readonly_user')
FROM pg_largeobject_metadata l
WHERE :'readonly_user' <> ''
  AND pg_get_userbyid(l.lomowner) = :'migrator_user'
\gexec

-- 5. Verification: every migrator-owned large object must now carry SELECT
--    for each configured export identity in its own ACL. Zero large objects
--    vacuously pass; one or more must all be covered.
SELECT EXISTS (
  SELECT 1
  FROM pg_largeobject_metadata lom
  CROSS JOIN LATERAL (VALUES (:'backup_user'), (:'readonly_user')) AS grantees(role_name)
  WHERE grantees.role_name <> ''
    AND pg_get_userbyid(lom.lomowner) = :'migrator_user'
    AND NOT EXISTS (
      SELECT 1
      FROM aclexplode(COALESCE(lom.lomacl, acldefault('L', lom.lomowner))) acl
      JOIN pg_roles grantee ON grantee.oid = acl.grantee
      WHERE grantee.rolname = grantees.role_name
        AND acl.privilege_type = 'SELECT'
    )
) AS has_unexportable_large_objects \gset
\if :has_unexportable_large_objects
  \echo 'Large-object verification failed: a migrator-owned large object is missing the SELECT grant for an export identity'
  DO $$
BEGIN
  RAISE EXCEPTION 'Large-object grant verification failed; see the diagnostic immediately above';
END
$$;
\endif

\echo 'Large-object export grants verified for the migrator owner and every configured export identity'
