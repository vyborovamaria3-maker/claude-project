import assert from 'node:assert/strict';
import { computeDevOutcomeAnalytics, type DevOutcomeTokenInput, type DevTemporalPointInput } from '../lib/trade/dev-history.ts';

const NOW = 1_800_000_000_000;
const horizons = { '5m':300_000,'15m':900_000,'1h':3_600_000,'6h':21_600_000,'24h':86_400_000 } as const;
const point=(t:number,p:number|null,liq:number|null=100_000,mc:number|null=null):DevTemporalPointInput=>({observedAt:t,priceUsd:p,liquidityUsd:liq,marketCapUsd:mc});
const regimes = {
 organic: {'5m':10,'15m':25,'1h':70,'6h':140,'24h':220},
 pumpDistribution: {'5m':45,'15m':90,'1h':20,'6h':-55,'24h':-88},
 rug: {'5m':-12,'15m':-45,'1h':-82,'6h':-96,'24h':-99},
 flat: {'5m':1,'15m':-1,'1h':2,'6h':-2,'24h':0},
} as const;

type R=keyof typeof regimes;
function token(i:number, regime:R, missingEvery=0):DevOutcomeTokenInput {
  const created=NOW-30*86_400_000+i*120_000;
  const base=1;
  const targets:any={};
  let k=0;
  for(const [h,off] of Object.entries(horizons)){
    k++;
    const miss=missingEvery>0 && (i+k)%missingEvery===0;
    const ret=(regimes as any)[regime][h];
    targets[h]=miss?null:point(created+off,base*(1+ret/100),100_000*(1+Math.max(-0.9,ret/200)));
  }
  return {mint:`${regime}-${i}`,symbol:regime,createdAt:created/1000,athUsd:regime==='organic'?3_000_000:regime==='pumpDistribution'?1_500_000:regime==='rug'?120_000:100_000,totalSupply:100_000,launchAnchor:point(created,base,100_000,100_000),launchTargets:targets};
}

const cohortResults:any={};
for(const regime of Object.keys(regimes) as R[]){
  const toks=Array.from({length:80},(_,i)=>token(i,regime,5));
  const out=computeDevOutcomeAnalytics({tokens:toks,nowMs:NOW,retentionDays:365});
  cohortResults[regime]={};
  for(const h of Object.keys(horizons) as Array<keyof typeof horizons>){
    const got=out.horizons[h].medianReturnPct;
    const expected=regimes[regime][h];
    assert.ok(got!=null && Math.abs(got-expected)<1e-9,`${regime} ${h} median ${got} != ${expected}`);
    assert.ok(out.horizons[h].coverage>0.7 && out.horizons[h].coverage<1,`${regime} ${h} coverage should reflect missingness`);
    cohortResults[regime][h]={median:got,coverage:out.horizons[h].coverage,samples:out.horizons[h].samples};
  }
}

// Delayed index: a +4m observation must NOT become the +5m label.
const created=NOW-2*86_400_000;
const delayed:DevOutcomeTokenInput={mint:'delayed',createdAt:created/1000,launchAnchor:point(created,1),launchTargets:{'5m':point(created+4*60_000,2)}};
const delayedOut=computeDevOutcomeAnalytics({tokens:[delayed],nowMs:NOW,retentionDays:14});
assert.equal(delayedOut.horizons['5m'].samples,0);

console.log(JSON.stringify({pass:true, devHistory: cohortResults, delayedPreHorizonRejected: true}, null, 2));
