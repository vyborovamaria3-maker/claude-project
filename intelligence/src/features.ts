import {
  parseTokenId, toUtcIso, type TokenId,
} from "@claude-project/contracts";
import type { PgTransaction } from "./entity-registry.js";

export const FEATURES_V1 = {
  version: "features-v1",
  fields: {
    mentions_5m: "nonnegative_integer",
    mentions_15m: "nonnegative_integer",
    mentions_1h: "nonnegative_integer",
    unique_authors: "nonnegative_integer",
    unique_sources: "nonnegative_integer",
    velocity: "finite_number",
    acceleration: "finite_number",
    sentiment_bullish_ratio: "ratio_or_null",
    bot_ratio: "ratio_or_null",
    smart_money_bought_at: "utc_timestamp_or_null",
    liquidity_usd: "nonnegative_number_or_null",
    volume_24h_usd: "nonnegative_number_or_null",
    holder_concentration: "ratio_or_null",
    decoder_coverage: "nonempty_string",
    history_coverage: "nonempty_string",
    data_confidence: "ratio",
  },
} as const;

export const FEATURES_V2 = {
  version: "features-v2",
  fields: {
    ...FEATURES_V1.fields,
    sentiment_score: "signed_ratio_or_null",
    copypasta_ratio: "ratio_or_null",
    narrative_id: "nonempty_string_or_null",
    velocity_5m: "finite_number_or_null",
    velocity_1h: "finite_number_or_null",
  },
} as const;

export const FEATURES_V3 = {
  version: "features-v3",
  fields: {
    ...FEATURES_V2.fields,
    embedding_ref: "nonempty_string_or_null",
    cluster_id: "nonempty_string_or_null",
    coherence_score: "ratio_or_null",
  },
} as const;

export type FeatureVersion = typeof FEATURES_V1.version | typeof FEATURES_V2.version | typeof FEATURES_V3.version;
type FeatureDefinition = { version: FeatureVersion; fields: Record<string, string> };
const FEATURE_DEFINITIONS: Record<FeatureVersion, FeatureDefinition> = {
  "features-v1": FEATURES_V1 as unknown as FeatureDefinition,
  "features-v2": FEATURES_V2 as unknown as FeatureDefinition,
  "features-v3": FEATURES_V3 as unknown as FeatureDefinition,
};

export type FeatureSnapshot = {
  canonicalTokenId: TokenId;
  asOf: Date | string;
  maxInputObservedAt: Date | string;
  featureVersion: FeatureVersion;
  features: Record<string, unknown>;
};

function isValid(value: unknown, rule: string): boolean {
  if (rule.endsWith("_or_null") && value === null) return true;
  switch (rule) {
    case "nonnegative_integer":return typeof value==="number" && Number.isSafeInteger(value) && value>=0;
    case "nonnegative_number_or_null":return typeof value==="number" && Number.isFinite(value) && value>=0;
    case "finite_number":return typeof value==="number" && Number.isFinite(value);
    case "finite_number_or_null":return typeof value==="number" && Number.isFinite(value);
    case "ratio":
    case "ratio_or_null":return typeof value==="number" && Number.isFinite(value) && value>=0 && value<=1;
    case "signed_ratio_or_null":return typeof value==="number" && Number.isFinite(value) && value>=-1 && value<=1;
    case "nonempty_string":return typeof value==="string" && value.trim().length>0 && value.length<=256;
    case "nonempty_string_or_null":return typeof value==="string" && value.trim().length>0 && value.length<=256;
    case "utc_timestamp_or_null":
      try {return typeof value==="string" && toUtcIso(value)===value;} catch {return false;}
    default:return false;
  }
}

export function validateFeatureSnapshot(input: FeatureSnapshot): {
  canonicalTokenId: TokenId; asOf: string; maxInputObservedAt: string;
  featureVersion: FeatureVersion; features: Record<string, unknown>;
} {
  if (parseTokenId(input.canonicalTokenId)?.id!==input.canonicalTokenId) {
    throw new TypeError("Noncanonical token ID");
  }
  const definition = FEATURE_DEFINITIONS[input.featureVersion];
  if (!definition) throw new TypeError("Unknown feature version");
  const asOf=toUtcIso(input.asOf), observed=toUtcIso(input.maxInputObservedAt);
  if (observed>asOf) throw new TypeError("Future-observed inputs are not allowed");
  if (typeof input.features!=="object"||input.features===null||Array.isArray(input.features)) {
    throw new TypeError("features must be an object");
  }
  const fields=definition.fields;
  for (const key of Object.keys(input.features)) {
    if (!Object.hasOwn(fields,key)) throw new TypeError("Unknown feature field: "+key);
  }
  for (const [field,rule] of Object.entries(fields)) {
    if (!Object.hasOwn(input.features,field)||!isValid(input.features[field],rule)) {
      throw new TypeError("Invalid or missing feature: "+field);
    }
  }
  const buys=input.features.smart_money_bought_at;
  if (typeof buys==="string" && buys>asOf) {
    throw new TypeError("smart_money_bought_at cannot be in the future");
  }
  return {
    canonicalTokenId:input.canonicalTokenId,asOf,
    maxInputObservedAt:observed,
    featureVersion:input.featureVersion,features:input.features,
  };
}

/** Ensure the feature registry is immutable for a given version. */
export async function registerFeatureVersion(
  tx: PgTransaction, featureVersion: FeatureVersion = FEATURES_V1.version,
): Promise<void> {
  const definition = FEATURE_DEFINITIONS[featureVersion];
  if (!definition) throw new TypeError("Unknown feature version");
  const json=JSON.stringify(definition);
  const insert=await tx.query(`INSERT INTO feature_versions(feature_version,definition)
    VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING feature_version`,
    [featureVersion,json]);
  if (insert.rows.length) return;
  const verified=await tx.query(`SELECT definition = $2::jsonb AS same
    FROM feature_versions WHERE feature_version=$1`,[featureVersion,json]);
  if (verified.rows.length!==1 || verified.rows[0]?.same!==true) {
    throw new Error("Feature definition version collision");
  }
}

/** Insert immutable as-of snapshot. Exact repeat is idempotent; changed repeat fails. */
export async function putFeatureSnapshot(tx: PgTransaction, source: FeatureSnapshot): Promise<boolean> {
  const x=validateFeatureSnapshot(source);
  const json=JSON.stringify(x.features);
  const result=await tx.query(`INSERT INTO chain_token_features
    (canonical_token_id,as_of,max_input_observed_at,feature_version,features)
    VALUES ($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(canonical_token_id,as_of,feature_version) DO NOTHING
    RETURNING canonical_token_id`,[
      x.canonicalTokenId,x.asOf,x.maxInputObservedAt,x.featureVersion,json,
    ]);
  if (result.rows.length) return true;
  const prior=await tx.query(`SELECT
    features=$5::jsonb AND max_input_observed_at=$3::timestamptz AS same
    FROM chain_token_features
    WHERE canonical_token_id=$1 AND as_of=$2 AND feature_version=$4`,[
      x.canonicalTokenId,x.asOf,x.maxInputObservedAt,x.featureVersion,json,
    ]);
  if (prior.rows.length!==1||prior.rows[0]?.same!==true) {
    throw new Error("Feature snapshot conflict: version or observation differs");
  }
  return false;
}

export async function queryFeaturesAsOf(
  tx: PgTransaction, tokenId: TokenId, asOf: Date | string,
  featureVersion: FeatureVersion = FEATURES_V1.version,
): Promise<Record<string, unknown> | null> {
  if (parseTokenId(tokenId)?.id!==tokenId) throw new TypeError("Noncanonical token ID");
  if (!FEATURE_DEFINITIONS[featureVersion]) throw new TypeError("Unknown feature version");
  const result=await tx.query(`SELECT canonical_token_id,as_of,max_input_observed_at,
    computed_at,feature_version,features
    FROM chain_token_features WHERE canonical_token_id=$1 AND feature_version=$2
      AND as_of <= $3 AND max_input_observed_at <= $3 AND computed_at <= $3
    ORDER BY as_of DESC LIMIT 1`,[
      tokenId,featureVersion,toUtcIso(asOf),
    ]);
  return result.rows[0]??null;
}
