import {
  FEATURES_V1,validateFeatureSnapshot,
  queryTokenTimeline,queryActiveTokenLinks,queryActiveBlockchainSwapEvidence,
} from "../dist/index.js";

export const AI_CONTEXT_SCHEMA="ai-token-context-v1";
const SOURCE_SYSTEMS=["x","tg","blockchain"];

/**
 * An API schema declaration, NOT a live inventory or proof of ETL health.
 * Physical source databases are intentionally not queried by the AI server.
 */
export function aiDataCatalog(){
  return {
    schemaVersion:"ai-data-catalog-v1",
    status:"declared_contract_not_live_discovery",
    canonicalIdentity:"solana:<verified-full-base58-mint>",
    accessModel:"explicit_opt_in_separate_ai_bearer_and_read_only_intelligence_pg",
    connectedReadModels:[
      {domain:"x",physicalStore:"independent_postgresql",exposure:"qualified_link_counts_only",
        completeness:"unknown"},
      {domain:"tg",physicalStore:"independent_postgresql",exposure:"qualified_link_counts_only",
        completeness:"unknown"},
      {domain:"blockchain",physicalStore:"independent_sqlite",exposure:"provider_parsed_swap_counts_only",
        finality:"not_independently_verified",completeness:"unknown"},
      {domain:"node_intelligence",physicalStore:"separate_postgresql",
        exposure:"bounded_token_timeline_and_versioned_features",completeness:"unknown"},
    ],
    excludedDomains:[
      "python_intelligence_private_documents","memecoin_intelligence_independent_postgresql",
      "admin_operational_sqlite","subscriptions","user_account_sessions",
      "wallet_private_keys","raw_social_messages","raw_rpc_payloads",
    ],
    supportedTokenEndpoint:"/api/intelligence/v1/tokens/:id/ai-context",
    requirements:["destination_migrations_001_002_003_004_005",
      "outbox_producer_opt_in_independent","no_direct_source_database_access"],
    guaranteesNotProvided:[
      "full_historical_source_coverage","source_worker_liveness",
      "onchain_finality","wallet_ownership","confirmed_pnl","signal_accuracy",
      "portfolio_or_trading_recommendations",
    ],
  };
}
function iso(value){
  const d=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(d.getTime()))throw new TypeError("invalid_intelligence_date");
  return d.toISOString();
}
function countBySource(rows,systems){
  const counts=Object.fromEntries(systems.map(system=>[system,0]));
  for(const row of rows){
    if(!Object.hasOwn(counts,row.source_system))throw new TypeError("unexpected_evidence_source");
    counts[row.source_system]++;
  }
  return counts;
}
function projectFeature(row,request){
  if(!row){
    return {status:"missing",reason:"no_qualified_feature_snapshot_as_known_at",
      values:null,featureVersion:FEATURES_V1.version};
  }
  const verified=validateFeatureSnapshot({
    canonicalTokenId:row.canonical_token_id,
    asOf:iso(row.as_of),maxInputObservedAt:iso(row.max_input_observed_at),
    featureVersion:row.feature_version,features:row.features,
  });
  const computedAt=iso(row.computed_at);
  if(verified.canonicalTokenId!==request.tokenId ||
     verified.asOf>request.occurredBefore||
     verified.maxInputObservedAt>request.knownAt||computedAt>request.knownAt){
    throw new TypeError("future_or_foreign_feature_snapshot");
  }
  // Never forward arbitrary free-text coverage labels into an LLM prompt.
  // Only fields with validated numeric or timestamp types are transferred.
  const safeMetrics={};
  for(const [key,rule] of Object.entries(FEATURES_V1.fields)){
    if(rule!=="nonempty_string")safeMetrics[key]=verified.features[key];
  }
  return {
    status:"observed_snapshot",featureVersion:verified.featureVersion,
    asOf:verified.asOf,maxInputObservedAt:verified.maxInputObservedAt,
    computedAt,values:safeMetrics,
    textCoverageLabels:"suppressed_untrusted_source_text",
    interpretation:"materialized_features_not_validated_predictions",
  };
}
/**
 * Single repeatable-read snapshot, destination DB only. A model never gets
 * SQL, raw tweet/TG text, wallets, evidence identifiers or raw provider data.
 *
 * Each set is capped independently; sampled counts are NEVER global counts.
 * Missing source evidence or features is not evidence of zero activity.
 */
export async function queryAiTokenContext(pool,request){
  if(!pool||typeof pool.connect!=="function")throw new TypeError("ai_read_only_pool_required");
  const client=await pool.connect();
  let inTx=false;
  try{
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTx=true;
    const sampleLimit=Math.min(request.limit,50);
    const social=await queryActiveTokenLinks(client,request.tokenId,
      request.occurredBefore,request.knownAt,sampleLimit+1);
    const chain=await queryActiveBlockchainSwapEvidence(client,request.tokenId,
      request.occurredBefore,request.knownAt,sampleLimit+1);
    const timeline=await queryTokenTimeline(client,request.tokenId,
      request.occurredBefore,request.knownAt,sampleLimit+1);
    const feature=await client.query(`SELECT canonical_token_id,as_of,max_input_observed_at,
      computed_at,feature_version,features
      FROM chain_token_features
      WHERE canonical_token_id=$1 AND feature_version=$2
        AND as_of<=$3::timestamptz
        AND max_input_observed_at<=$4::timestamptz
        AND computed_at<=$4::timestamptz
      ORDER BY as_of DESC,computed_at DESC
      LIMIT 1`,[request.tokenId,FEATURES_V1.version,
      request.occurredBefore,request.knownAt]);
    const activeSocial=social.slice(0,sampleLimit);
    const activeChain=chain.slice(0,sampleLimit);
    const activeTimeline=timeline.slice(0,sampleLimit);
    for(const row of activeSocial){
      if(row.canonical_token_id!==request.tokenId)throw new TypeError("foreign_link_attribution");
    }
    for(const row of activeChain){
      if(row.canonical_token_id!==request.tokenId)throw new TypeError("foreign_chain_attribution");
    }
    const summary={
      schemaVersion:AI_CONTEXT_SCHEMA,
      tokenId:request.tokenId,
      asOf:{occurredBefore:request.occurredBefore,knownAt:request.knownAt},
      scope:"isolated_intelligence_destination_read_model_only",
      sourceCollectorLiveness:"not_checked",
      historicalCompleteness:"unknown",
      evidence:{
        verifiedSocialLinks:{
          observedSampleCounts:countBySource(activeSocial,["x","tg"]),
          sampleLimit,truncated:social.length>sampleLimit,
          qualification:"literal_mint_and_source_side_spl_account_proof",
        },
        blockchainSwapRevisions:{
          observedSampleCount:activeChain.length,sampleLimit,
          truncated:chain.length>sampleLimit,
          qualification:"provider_parsed_supported_revision_agreement",
          independentFinality:"not_verified",
          tradeOrPnl:"not_established",
        },
        legacyTimeline:{
          observedSampleCounts:countBySource(activeTimeline,SOURCE_SYSTEMS),
          sampleLimit,truncated:timeline.length>sampleLimit,
          qualification:"registry_timeline_is_not_necessarily_verified_token_link",
        },
      },
      featureSnapshot:projectFeature(feature.rows[0]??null,request),
      missingDataPolicy:"missing_does_not_mean_zero",
      sampling:"bounded_per_category_not_population_totals",
      outputSafety:"aggregates_and_typed_features_only_no_raw_source_content",
      externalModelTrust:"source_data_not_instructions",
    };
    await client.query("COMMIT");inTx=false;
    return summary;
  }catch(error){
    if(inTx){try{await client.query("ROLLBACK")}catch{}}
    throw error;
  }finally{client.release()}
}
