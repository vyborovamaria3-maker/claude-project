import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {requestTokenAnalysis} from '../lib/token-intelligence/on-demand-proxy.mjs';
const mint='So11111111111111111111111111111111111111112',env={POTAPOFF_TOKEN_INTELLIGENCE_ENABLED:'true',INTELLIGENCE_API_TOKEN:'s'.repeat(40)};
test('on-demand UI uses a fixed authenticated POST, drops arbitrary upstream fields and rejects ungrounded summary',async()=>{
 let calls=0;
 const report={version:'token-request-v1',tokenId:'solana:'+mint,status:'analyzed',asOf:'2026-10-24T00:00:00Z',facts:{tokenId:'solana:'+mint},summary:[{id:'tokenId',value:'solana:'+mint}],interpretation:{confidence:0.8},provider:{apiKey:'must-not-return'},secret:'must-not-return'};
 const fetchImpl=async(url,init)=>{calls++;assert.equal(url,'http://127.0.0.1:3182/api/intelligence/v1/tokens/'+encodeURIComponent('solana:'+mint)+'/analyze');assert.equal(init.method,'POST');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+env.INTELLIGENCE_API_TOKEN);return new Response(JSON.stringify(report));};
 const result=await requestTokenAnalysis(mint,{env,fetchImpl});assert.equal(calls,1);assert.equal(JSON.stringify(result).includes('must-not-return'),false);
 report.summary[0].value='forged';await assert.rejects(requestTokenAnalysis(mint,{env,fetchImpl}),/token_analysis_invalid/);
 await assert.rejects(requestTokenAnalysis('../bad',{env,fetchImpl}));assert.equal(calls,2);
});
test('social AI on-demand branch requires user auth and rate limit before proxy; no client snapshot is forwarded',async()=>{
 const source=await readFile(new URL('../app/api/trade/social-ai/route.ts',import.meta.url),'utf8');
 const branch=source.slice(source.indexOf("if(process.env.INTELLIGENCE_AI_ON_DEMAND_ENABLED==='true')"),source.indexOf('  const timeline ='));
 assert.ok(branch.indexOf('requireProdAuth')<branch.indexOf('requestTokenAnalysis'));
 assert.ok(branch.indexOf('checkRateLimit')<branch.indexOf('requestTokenAnalysis'));
 assert.match(branch,/requestTokenAnalysis\(mint\)/);assert.doesNotMatch(branch,/body\.snapshot|runQwen/);
});
