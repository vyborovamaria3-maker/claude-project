import { performance } from 'node:perf_hooks';
import { computeDevOutcomeAnalytics, type DevOutcomeTokenInput } from '../lib/trade/dev-history.ts';
const nowMs=1_800_000_000_000; const tokens:DevOutcomeTokenInput[]=[];
for(let i=0;i<5000;i++){const c=nowMs-(i%20)*3600000-172800000; const p=(at:number,x:number)=>({observedAt:at,priceUsd:x,liquidityUsd:100000,marketCapUsd:x*1e9}); tokens.push({mint:`M${i}`,createdAt:Math.floor(c/1000),athUsd:1e6,totalSupply:null,launchAnchor:p(c,.0001),launchTargets:{'5m':p(c+300000,.00011),'15m':p(c+900000,.00012),'1h':p(c+3600000,.00013),'6h':p(c+21600000,.00009),'24h':p(c+86400000,.00007)},migrationAt:null});}
for(let i=0;i<5;i++)computeDevOutcomeAnalytics({tokens,nowMs}); const xs=[]; for(let i=0;i<30;i++){const t=performance.now();computeDevOutcomeAnalytics({tokens,nowMs});xs.push(performance.now()-t)} xs.sort((a,b)=>a-b); console.log(JSON.stringify({medianMs:xs[15],p95Ms:xs[Math.floor(xs.length*.95)],avgMs:xs.reduce((a,b)=>a+b,0)/xs.length}));
