import assert from 'node:assert/strict';
import { computeDevOutcomeAnalytics, computeDevHistoryAnalytics, type DevOutcomeTokenInput, type DevHistoryTokenInput } from '../lib/trade/dev-history.ts';
let seed = 123456789;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2**32);
const maybe = (v:number) => rnd() < 0.22 ? null : v;
const nowMs = 1_800_000_000_000;
for (let k=0;k<1000;k++) {
  const n = 1 + Math.floor(rnd()*80);
  const outTokens: DevOutcomeTokenInput[] = [];
  const histTokens: DevHistoryTokenInput[] = [];
  for (let i=0;i<n;i++) {
    const createdMs = nowMs - Math.floor(rnd()*40*86_400_000) + (rnd()<0.03 ? 3_600_000 : 0);
    const price = 10 ** (-7 + rnd()*5);
    const p = (at:number, mul=1) => rnd()<0.2 ? null : ({observedAt:at + Math.floor((rnd()-.5)*8*60_000), priceUsd: maybe(price*mul), liquidityUsd: maybe(Math.floor(rnd()*200000)), marketCapUsd: maybe(Math.floor(rnd()*2_000_000))});
    const createdSec = Math.floor(createdMs/1000);
    const migrationMs = createdMs + Math.floor(rnd()*3_600_000);
    outTokens.push({mint:`M${k}_${i}`, createdAt:rnd()<0.1?createdMs:createdSec, athUsd:maybe(Math.floor(10_000+rnd()*2_000_000)), totalSupply:null, launchAnchor:p(createdMs), launchTargets:{'5m':p(createdMs+300000,1.1),'15m':p(createdMs+900000,.9),'1h':p(createdMs+3600000,1.2),'6h':p(createdMs+21600000,.5),'24h':p(createdMs+86400000,.2)}, migrationAt:rnd()<.5?Math.floor(migrationMs/1000):null, migrationAnchor:p(migrationMs), migrationTargets:{'1h':p(migrationMs+3600000,1.1),'6h':p(migrationMs+21600000,.7),'24h':p(migrationMs+86400000,.3)}});
    histTokens.push({mint:`M${k}_${i}`,createdAt:rnd()<.1?createdMs:createdSec,athUsd:maybe(Math.floor(10_000+rnd()*2_000_000)),marketCapUsd:maybe(Math.floor(rnd()*500000)),isMigrated:rnd()<.3,reached300k:rnd()<.2,totalSupply:null});
  }
  const o=computeDevOutcomeAnalytics({tokens:outTokens,nowMs,retentionDays:14});
  const h=computeDevHistoryAnalytics({tokens:histTokens,nowSec:nowMs/1000});
  for (const row of Object.values(o.horizons)) {
    for (const v of [row.coverage,row.retentionCoverage,row.positiveReturnRate]) assert.ok(v==null || (Number.isFinite(v)&&v>=0&&v<=1));
    for (const v of [row.meanReturnPct,row.medianReturnPct,row.p25ReturnPct,row.p75ReturnPct,row.medianRecordedAthDrawdownPct]) assert.ok(v==null||Number.isFinite(v));
  }
  for (const row of Object.values(o.postMigration.horizons)) {
    for (const v of [row.returnCoverage,row.retentionReturnCoverage,row.survivalCoverage,row.retentionSurvivalCoverage,row.survivalRate,row.positiveReturnRate]) assert.ok(v==null || (Number.isFinite(v)&&v>=0&&v<=1));
  }
  assert.ok(h.ath.coverage>=0&&h.ath.coverage<=1);
}
console.log('DEV_HISTORY_V301_FUZZ_PASS=1000/1000');
