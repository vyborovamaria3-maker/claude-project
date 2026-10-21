"use strict";
// Explicit fail-closed prerequisites for allowing a future inventory/PnL ledger.
// A snapshot, even if internally consistent, cannot prove finality or cost basis.
function coverage(source){
  const present=source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_forensic_history_coverage'").get();
  if(!present)return {state:"MISSING",targets:null,gapOrIncomplete:null};
  const columns=new Set(source.prepare("PRAGMA table_info(chain_forensic_history_coverage)").all().map(c=>c.name));
  if(!columns.has("possible_gap")||!columns.has("backfill_complete"))
    return {state:"UNSUPPORTED_SCHEMA",targets:null,gapOrIncomplete:null};
  const r=source.prepare("SELECT COUNT(*) targets, COALESCE(SUM(CASE WHEN possible_gap<>0 OR backfill_complete<>1 THEN 1 ELSE 0 END),0) gapOrIncomplete FROM chain_forensic_history_coverage").get();
  return {state:r.targets && !r.gapOrIncomplete?"PROVIDER_FLAGS_OBSERVED":"GAPS_OR_MISSING_COVERAGE",
    targets:r.targets,gapOrIncomplete:r.gapOrIncomplete};
}
function assess(source,stats){
  const c=coverage(source);
  const blockers=[
    "FINALITY_NOT_INDEPENDENTLY_VERIFIED",
    "OWNERSHIP_CONTINUITY_NOT_PROVEN",
    "INVENTORY_COST_BASIS_NOT_PROVEN"
  ];
  if(stats.sampleTruncated)blockers.push("BOUNDED_SAMPLE_NOT_FULL_HISTORY");
  if(stats.rejectedSignatures)blockers.push("INVALID_OR_DIVERGENT_RAW_SIGNATURES");
  if(stats.ownerTransitionWarnings)blockers.push("OWNER_OR_MINT_TRANSITION_UNRESOLVED");
  if(c.state!=="PROVIDER_FLAGS_OBSERVED")blockers.push("HISTORICAL_COVERAGE_NOT_EXHAUSTIVE");
  // Even provider pagination flags are not proof of completeness/finality.
  return {canPromoteToAuthoritativeInventory:false,canPromoteToPnl:false,coverage:c,
    blockers,description:"Read-only evidence gate. Passing provider pagination is insufficient for financial authority."};
}
module.exports={coverage,assess};
