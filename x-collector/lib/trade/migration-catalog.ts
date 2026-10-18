import { REQUIRED } from "./migrations";

/**
 * SQL files present in the repository but deliberately excluded from the
 * execution manifest. Historical filenames are part of the database ledger;
 * do not rename/replay them without a compatibility migration.
 */
export const EXCLUDED_MIGRATIONS: Readonly<Record<string,string>> = Object.freeze({
  "012_ai_reply_guy.sql": "Alternate historical Reply Guy/X account schema; reconcile before adoption.",
  "025_intelligence_identity_resolution.sql": "Unadopted identity extensions; reconcile with the active intelligence schema.",
  "026_intelligence_tags_v2.sql": "Unadopted tag extensions; reconcile with the active tag schema.",
  "027_intelligence_scores.sql": "Unadopted scoring extensions; reconcile with the active intelligence schema.",
  "028_intelligence_graph_timeline.sql": "Unadopted graph timeline extensions; reconcile with the active relation schema.",
  "030_intelligence_jobs.sql": "Unadopted jobs schema; BIGINT entity references conflict with current UUID entity IDs.",
  "031_intelligence_graph_analytics.sql": "Unadopted graph metrics; BIGINT entity references conflict with current UUID entity IDs.",
  "036_tweet_entities.sql": "Legacy tweet-entity table; reconcile with the active twitter_entity_links model.",
});

/** Existing historical number collisions. They are intentional legacy state. */
export const ALLOWED_NUMERIC_COLLISIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "012": ["012_ai_reply_guy.sql", "012_graph_monitoring.sql", "012_reply_guy.sql"],
  "013": ["013_intelligence.sql", "013_reply_performance.sql"],
  "014": ["014_archive.sql", "014_signals_engine.sql"],
  "036": ["036_investigations.sql", "036_tweet_entities.sql"],
});

export interface MigrationCatalogAudit {
  appliedOrder: readonly string[];
  excluded: readonly { filename: string; reason: string }[];
  collisions: readonly { sequence: string; filenames: string[] }[];
  errors: string[];
}

const duplicates = (values: readonly string[]): string[] => {
  const seen = new Set<string>(), result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return [...result].sort();
};

/** Pure preflight: filesystem only, no database connection and no SQL execution. */
export function auditMigrationCatalog(files: readonly string[]): MigrationCatalogAudit {
  const actual = files.filter(file => file.endsWith(".sql")).sort();
  const errors: string[] = [];

  for (const filename of duplicates(REQUIRED)) errors.push(`Duplicate REQUIRED filename: ${filename}`);
  for (const filename of duplicates(actual)) errors.push(`Duplicate SQL file listing: ${filename}`);

  const expected = new Set([...REQUIRED, ...Object.keys(EXCLUDED_MIGRATIONS)]);
  for (const filename of REQUIRED) {
    if (!actual.includes(filename)) errors.push(`Missing required SQL migration: ${filename}`);
  }
  for (const filename of Object.keys(EXCLUDED_MIGRATIONS)) {
    if (!actual.includes(filename)) errors.push(`Missing documented excluded SQL migration: ${filename}`);
  }
  for (const filename of actual) {
    if (!expected.has(filename)) errors.push(`Unregistered SQL migration (not auto-applied): ${filename}`);
  }
  for (const filename of Object.keys(EXCLUDED_MIGRATIONS)) {
    if (REQUIRED.includes(filename)) errors.push(`Both required and excluded SQL migration: ${filename}`);
  }

  const grouped = new Map<string,string[]>();
  for (const filename of actual) {
    const match = /^(\d{3})_[A-Za-z0-9_-]+\.sql$/.exec(filename);
    if (!match) {
      errors.push(`Invalid SQL migration filename: ${filename}`);
      continue;
    }
    const group = grouped.get(match[1]) ?? [];
    group.push(filename);
    grouped.set(match[1], group);
  }

  const collisions = [...grouped.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([sequence, filenames]) => ({ sequence, filenames: [...filenames].sort() }))
    .sort((a,b) => a.sequence.localeCompare(b.sequence));

  for (const { sequence, filenames } of collisions) {
    const allowed = [...(ALLOWED_NUMERIC_COLLISIONS[sequence] ?? [])].sort();
    if (JSON.stringify(filenames) !== JSON.stringify(allowed)) {
      errors.push(`Undocumented numeric migration collision ${sequence}: ${filenames.join(", ")}`);
    }
  }
  for (const sequence of Object.keys(ALLOWED_NUMERIC_COLLISIONS)) {
    if (!collisions.some(item => item.sequence === sequence)) {
      errors.push(`Stale numeric collision declaration: ${sequence}`);
    }
  }

  return {
    appliedOrder: [...REQUIRED],
    excluded: Object.entries(EXCLUDED_MIGRATIONS).map(([filename, reason]) => ({ filename, reason })),
    collisions,
    errors,
  };
}

export function assertMigrationCatalog(files: readonly string[]): MigrationCatalogAudit {
  const audit = auditMigrationCatalog(files);
  if (audit.errors.length) throw new Error(`Migration inventory mismatch: ${audit.errors.join("; ")}`);
  return audit;
}
