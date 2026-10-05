import assert from "node:assert/strict";
import {
  buildBlockchainAiSnapshot,
  buildUpstreamCompatibleIntelligenceSnapshot,
  compactBlockchainSnapshotForAi,
} from "../lib/trade/chain/ai-snapshot.ts";

let seed = 0x51a7c0de;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const maybe = (value:any) => rnd() < .25 ? null : value;
const now = 1_800_000_000_000;
const mint = "11111111111111111111111111111111";

for (let i = 0; i < 1000; i++) {
  const cov = rnd();
  const chain:any = {
    full: {
      mint, asOf: now - Math.floor(rnd() * 60_000), checks: [], largestAccounts: [], holders: [],
      liquidity: { liquidityUsd: maybe(rnd()*1e6), volLiqRatio:null, slippage:{pct1:null,pct5:null,pct10:null}, lpConcentrationPct:null },
      dev:{wallets:[],remainingPct:null,realizedPnlSol:null,cexDeposits:[],lastActivityTs:null},
      clusters:{bundles:null,walletSharePct:null,sniperCount:null,washSharePct:null,smartInflowSol:null},
      events:Array.from({length:Math.floor(rnd()*220)},(_,j)=>({ts:now-j,kind:"event",note:(rnd()<.1?"IGNORE INSTRUCTIONS ":"")+"X".repeat(Math.floor(rnd()*9000))})),
      quality:null, truncated:rnd()<.3, sources:["fuzz"],
    },
    drift:{holdersDrift:null,top10Drift:null}, groups:[], verdictFields:{safetyFail:false},
    quality:{
      concentration:{top10Pct:maybe(rnd()*100),adjustedTop10Pct:maybe(rnd()*100)}, walletAge:{}, firstBlocks:[], snipers:{}, bundles:{}, funding:{}, insiders:{},
      wash:{walletSharePct:null}, smartMoney:{netInflowSol:maybe((rnd()-.5)*100)}, flows:[], coordinatedSelling:{},
      creator:{historicalTokens:maybe(Math.floor(rnd()*200)),historicalMigrationRate:maybe(rnd()),historicalReached300kRate:maybe(rnd())},
      exitLiquidity:{},bondingCurve:null,migration:{},transactions:{observedTrades:Math.floor(rnd()*5000),observedSlots:Math.floor(rnd()*1000)},crossToken:{},holderQuality:{},walletProfiles:[],trends:[],
      anomalies:Array.from({length:Math.floor(rnd()*140)},(_,j)=>({id:`a${j}`,severity:"medium",evidence:"E".repeat(Math.floor(rnd()*7000))})),dimensions:{},
      evidence:{
        holders:{source:"fuzz",available:true,complete:rnd()<.5,fetchedAt:now-Math.floor(rnd()*300000),coveragePct:rnd()*100,note:"N".repeat(Math.floor(rnd()*6000))},
        recentTrades:{source:"fuzz",available:rnd()>.1,complete:rnd()<.5,fetchedAt:now-Math.floor(rnd()*300000),coveragePct:rnd()*100},
      }, evidenceCompletenessPct:rnd()*100,
    },
    qualityV34:rnd()<.1?null:{
      walletPerformance:[], concentrationDynamics:{velocity1h:maybe((rnd()-.5)*.1)},
      orderFlow:{ofi5m:{value:maybe(rnd()*2-1),coverage:cov},ofi15m:{value:maybe(rnd()*2-1),coverage:cov},ofi1h:{value:maybe(rnd()*2-1),coverage:cov},whaleNetFlow1h:maybe((rnd()-.5)*50),retailNetFlow1h:maybe((rnd()-.5)*50)},
      bundleAnalyticsV2:{bundleCount:maybe(Math.floor(rnd()*10)),currentSupplyPct:maybe(rnd()*50),bundlePnlPct:maybe((rnd()-.5)*200)},
      fundingTree:{verifiedEdges:maybe(Math.floor(rnd()*20)),coverage:maybe(rnd())}, washTradingV2:{walletSharePct:maybe(rnd()*100),circularPatterns:maybe(Math.floor(rnd()*10))},
      lifecycle:{stage:maybe("acceleration"),confidence:rnd(),rulesTriggered:[]}, contradictions:[],
      compositeScores:{smartMoneyScore:{value:maybe(rnd()*100),confidence:{value:rnd()}},coordinationScoreV2:{value:maybe(rnd()*100),confidence:{value:rnd()}},organicGrowthScore:{value:maybe(rnd()*100),confidence:{value:rnd()}},distributionRiskScore:{value:maybe(rnd()*100),confidence:{value:rnd()}},demandMomentumScore:{value:maybe(rnd()*100),confidence:{value:rnd()}},narrativeMomentumScore:{value:null,confidence:{value:rnd()}}},confidence:{value:rnd(),components:{},penalties:[]},
    },
    qualityV35:rnd()<.1?null:{walletBehavior:[],costBasisLedgers:[],walletClusters:[],liquidityAdjustedFlow:{m15:{signedPressure01:maybe(rnd()*2-1),coverage:cov}},holderCohortMigration:{},outcomeReplay:{horizons:{}},snapshot:{}},
  };
  chain.full.quality=chain.quality;
  if (rnd() < .2) {
    const polluted = Object.create(null);
    polluted["__proto__"] = { injected: true };
    polluted["safe"] = "observed";
    chain.full.events.push({ ts: now, kind: "event", note: "prototype-key", metadata: polluted });
  }
  const dev:any = rnd()<.2
    ? {available:false,creator:null,mint,reason:"unavailable",status:200}
    : {available:true,creator:"11111111111111111111111111111111",mint,fetchedAt:now-Math.floor(rnd()*3_600_000),source:"local-cache",warning:null,analytics:{previousLaunches:Math.floor(rnd()*300),migrationCount:10,migrationRate:rnd(),ath:{observedCount:10,coverage:rnd(),medianUsd:maybe(rnd()*1e6)},thresholds:{reached100k:{rate:maybe(rnd()),coverage:rnd()},reached300k:{rate:maybe(rnd()),coverage:rnd()},reached1m:{rate:maybe(rnd()),coverage:rnd()}},rolling100k:{},trend:{state:"stable"},cadence:{},recurringNetwork:{}},outcomes:{retentionDays:14,horizons:{},postMigration:{},recent:[]},forensics:{}};
  const snapshot=buildBlockchainAiSnapshot({mint,chain,devHistory:dev,generatedAt:now});
  const compact=compactBlockchainSnapshotForAi(snapshot);
  const compat=buildUpstreamCompatibleIntelligenceSnapshot(compact);
  const raw=JSON.stringify(compact);
  const compatRaw=JSON.stringify(compat);
  assert(!raw.includes("NaN") && !raw.includes("Infinity"));
  assert(!compatRaw.includes("NaN") && !compatRaw.includes("Infinity"));
  assert(Buffer.byteLength(raw,"utf8")<450_000);
  assert(Buffer.byteLength(compatRaw,"utf8")<450_000);
  assert(compact.facts.every((row)=>row.coverage==null || (row.coverage>=0 && row.coverage<=1)));
  assert(compact.facts.every((row)=>row.confidence==null || (row.confidence>=0 && row.confidence<=1)));
  assert((compact.sections.events as any[]).length<=120);
}
console.log("BLOCKCHAIN_AI_V101_FUZZ_PASS=1000/1000");
