-- Repair existing function definitions as well as fresh installations.
-- PostgreSQL folds integer constants even inside unused COALESCE branches.
DO $$
DECLARE
  definition TEXT;
BEGIN
  FOR definition IN
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.prokind = 'f'
      AND p.prosrc ~ '\m(30|90)[[:space:]]*\*[[:space:]]*86400000\M(?![[:space:]]*::)'
  LOOP
    EXECUTE regexp_replace(definition,
      '\m(30|90)[[:space:]]*\*[[:space:]]*86400000\M(?![[:space:]]*::)',
      '\1 * 86400000::BIGINT', 'g');
  END LOOP;
END
$$;
