import { REQUIRED } from "./migrations";

/**
 * Historical SQL files intentionally not executed by the current migration
 * manifest. These are NOT safe to apply just because the filename is present.
 * Keep explicit until each schema is reconciled in a dedicated migration PR.
 */
export const EXCLUDED_MIGRATIONS: Readonly<Record<string,string>> = Object.freeze({
  "012_ai_reply_guy.sql": "Obsolete alternate Reply Guy/X account schema; reconcile with 012_reply_guy.sql before adoption.",
  "025_intelligence_identity_resolution.sql": "Unadopted intelligence identity extensions; requires explicit compatibility review.",
  "026_intelligence_tags_v2.sql": "Unadopted tag extensions; requires current tag schema compatibility review.",
  "027_intelligence_scores.sql": "Unadopted scoring extensions; requires current intelligence schema review.",
  "028_intelligence_graph_timeline.sql": "Unadopted graph timeline extensions; requires existing relation schema review.",
  "030_intelligence_jobs.sql": "Unadopted jobs schema; BIGINT entity foreign key conflicts with UUID ip_entities.id.",
  "031_intelligence_graph_analytics.sql": "Unadopted graph metrics; BIGINT entity foreign key conflicts with UUID ip_entities.id.",
  "036_tweet_entities.sql": "Standalone legacy tweet entity table; review against active twitter_entity_links.",
});

/** Legacy numeric collisions are documented, not silently renumbered. */
export const ALLOWED_NUMERIC_COLLISIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "012": ["012_ai_reply_guy.sql", "012_graph_monitoring.sql", "012_reply_guy.sql"],
  "013": ["013_intelligence.sql", "013_reply_performance.sql"],
  "014": ["014_archive.sql", "014_signals_engine.sql"],
  "036": ["036_investigations.sql", "036_tweet_entities.sql"],
});

export interface MigrationCatalogAudit {
  appliedOrder: readonly string[];
  excluded: readonly {filename:string; reason:string}[];
  collisions: readonly {sequence:string; filenames:string[]}[];
  errors: string[];
}

function duplicates(values:readonly string[]):string[] {
  const seen=new Set<string>(), duplicate=new Set<string>();
  for(const value of values){if(seen.has(value))duplicate.add(value);seen.add(value);}
  return [...duplicate].sort();
}

/**
 * Pure preflight. No SQL is executed and no existing schema_migrations rows
 * are rewritten; old installations are keyed by the ORIGINAL full filenames.
 */
export function auditMigrationCatalog(files:readonly string[]):MigrationCatalogAudit {
  const actual=files.filter(f=>f.endsWith(".sql")).sort();
  const errors:string[]=[];
  for(const item of duplicates(REQUIRED))errors.push(`Duplicate REQUIRED filename: ${item}`);
  for(const item of duplicates(actual))errors.push(`Duplicate SQL file listing: ${item}`);
  const expected=new Set([...REQUIRED,...Object.keys(EXCLUDED_MIGRATIONS)]);
  for(const filename of REQUIRED)if(!actual.includes(filename))
    errors.push(`Missing required SQL migration: ${filename}`);
  for(const filename of Object.keys(EXCLUDED_MIGRATIONS))if(!actual.includes(filename))
    errors.push(`Missing documented excluded SQL migration: ${filename}`);
  for(const filename of actual)if(!expected.has(filename))
    errors.push(`Unregistered SQL migration (not auto-applied): ${filename}`);
  for(const filename of Object.keys(EXCLUDED_MIGRATIONS))if(REQUIRED.includes(filename))
    errors.push(`Both required and excluded SQL migration: ${filename}`);
  const grouped=new Map<string,string[]>();
  for(const filename of actual) {
    const match=/^(\d{3})_[A-Za-z0-9_-]+\.sql$/.exec(filename);
    if(!match){errors.push(`Invalid SQL migration filename: ${filename}`);continue;}
    const group=grouped.get(match[1])??[];
    group.push(filename);
    grouped.set(match[1],group);
  }
  const collisions=[...grouped.entries()].filter(([,group])=>group.length>1)
    .map(([sequence,filenames])=>({sequence,filenames:filenames.sort()}))
    .sort((a,b)=>a.sequence.localeCompare(b.sequence));
  for(const {sequence,filenames} of collisions) {
    const allowed=[...(ALLOWED_NUMERIC_COLLISIONS[sequence]??[])].sort();
    if(JSON.stringify(filenames)!==JSON.stringify(allowed))
      errors.push(`Undocumented numeric migration collision ${sequence}: ${filenames.join(", ")}`);
  }
  for(const sequence of Object.keys(ALLOWED_NUMERIC_COLLISIONS))
    if(!collisions.some(item=>item.sequence===sequence))
      errors.push(`Stale numeric collision declaration: ${sequence}`);
  const excluded=Object.entries(EXCLUDED_MIGRATIONS)
    .map(([filename,reason])=>({filename,reason}));
  return {appliedOrder:[...REQUIRED],excluded,collisions,errors};
}

export function assertMigrationCatalog(files:readonly string[]):MigrationCatalogAudit {
  const audit=auditMigrationCatalog(files);
  if(audit.errors.length)throw new Error("Migration inventory mismatch: "+audit.errors.join("; "));
  return audit;
}
