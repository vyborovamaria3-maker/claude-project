import test from 'node:test';import assert from 'node:assert/strict';
import {isLowValueTelegramPost,isLowValueTwitterPost,twitterEvidenceKey} from '../dist/index.js';
import {collectTokenInputs,analyzeTokenOnDemand} from '../scripts/token-analysis.mjs';
const mint='So11111111111111111111111111111111111111112';
const card=`🎲 $SAMPLE | MC: 20K\nVol: 30K | Top 10: 15 | Holders: 100\n\n${mint}\n\nSafer & Quality -> Join Private\n\n⚡️Snip: Example | Other⚡️\n\nCheck the CHART - Find ur entry, don't fomo !!!\n\nAds: Join our sample group - @example`;
const call=`12.3X 🚀 from my $SAMPLE call.\n\nCalled early. Momentum went CRAZY. 📈\n\nCA: ${mint}\n\n#Solana #Memecoin https://t.co/one`;
const watch=`5.1k to $SAMPLE 🚀\n\nCA: ${mint}\n\nKeeping an eye on this one.👀\n\n#Solana #CryptoAlpha https://t.co/two`;
test('complete affiliate metric cards excluded; negations, sarcasm and surrounding criticism preserved',()=>{
 assert.equal(isLowValueTelegramPost(card),true);
 for(const text of ['Do not buy this card.\n'+card,card+'\nThese numbers are fake; do not buy.','Great, another "safe" token. Lost everything. '+mint,'MC: 20K, Vol: 30K, Holders: 100. I would not buy '+mint])assert.equal(isLowValueTelegramPost(text),false,text);
});
test('Twitter full call templates excluded without rejecting human opinions or criticism',()=>{
 for(const text of [call,watch])assert.equal(isLowValueTwitterPost(text),true);
 for(const text of ['This claimed 12.3X is not verified. '+mint,'I am bullish, but liquidity looks risky '+mint,call+'\nActually I sold at a loss.','This is advertising, not my call.\n'+watch])assert.equal(isLowValueTwitterPost(text),false,text);
});
test('Twitter duplicate key ignores only short-link tracking and whitespace; preserves denial, numbers and URLs',()=>{
 assert.equal(twitterEvidenceKey(call),twitterEvidenceKey(call.replace('t.co/one','t.co/different').replace(/\n/g,'  ')));
 for(const text of [call.replace('12.3X','2X'),'Not '+call,call.replace('https://t.co/one','https://example.com/evidence')])assert.notEqual(twitterEvidenceKey(call),twitterEvidenceKey(text));
});
const sources={x:{query:async()=>({rows:[call,watch,call.replace('t.co/one','t.co/three'),watch.replace('t.co/two','t.co/four')].map((text,i)=>({tweet_id:String(i),text,updated_at:Date.now()-1000}))})},tg:{query:async()=>({rows:[{message_id:1,peer_id:'123',text:card}]})},chain:{prepare:()=>({all:()=>[]})}};
test('advert-only real-shape batch yields zero social evidence and records exclusions before AI',async()=>{
 const input=await collectTokenInputs(sources,'solana:'+mint);
 assert.equal(input.messages.length,0);assert.equal(input.facts['tg.filteredTemplates'],1);assert.equal(input.facts['x.filteredTemplates'],2);assert.equal(input.facts['x.duplicateMessages'],2);
 let saved;const tx={query:async(sql,args)=>{if(sql.includes('FROM model_registry'))return{rows:[{model_id:'test',provider:'test',name:'test',version:'1'}]};if(sql.startsWith('INSERT INTO token_ai_requests'))saved=JSON.parse(args[3]);return{rows:[]};},release(){}};
 const report=await analyzeTokenOnDemand({destination:{connect:async()=>tx},sources,gateway:{chatCompletion(){assert.fail('advert-only batch must not call provider')}},modelId:'test',tokenId:'solana:'+mint});
 assert.equal(report.status,'no_evidence');assert.equal(report.interpretation,null);assert.equal(report.provider,null);assert.equal(saved.status,'no_evidence');
});
test('useful Twitter duplicates contribute only one independent message; negation remains distinct',async()=>{
 const text='I would not buy '+mint+' https://t.co/first';
 const input=await collectTokenInputs({...sources,x:{query:async()=>({rows:[text,text.replace('first','second'),'I would buy '+mint].map((text,i)=>({tweet_id:String(i),text,updated_at:Date.now()-1000}))})}},'solana:'+mint);
 assert.equal(input.messages.length,2);assert.equal(input.facts['x.duplicateMessages'],1);assert.match(input.messages[0].text,/not buy/);
});

test('UI explicitly explains advert exclusions and no provider call when evidence is empty',async()=>{
 const {tokenSummary}=await import('../../solana-launcher/lib/token-intelligence/on-demand-proxy.mjs');
 const summary=tokenSummary({status:'no_evidence',facts:{'tg.sampledMessages':0,'x.sampledMessages':0,'chain.sampledStoredTradeRows':0,'tg.filteredTemplates':4,'x.filteredTemplates':2,'x.duplicateMessages':2},interpretation:null});
 assert.match(summary,/Недостаточно сообщений/);assert.match(summary,/Telegram — 4, Twitter — 2; повторов Twitter — 2/);assert.match(summary,/ИИ не вызывался/);assert.doesNotMatch(summary,/позитивное отношение/);
});

test('deeper call-card variants are excluded without swallowing attached criticism',()=>{
 const tail=`\n\nCA&gt;\n${mint}\n\n#Solana #Memecoin https://t.co/example`;
 const cards=[`Found $SAMPLE at just $3.1K 🔍\n\nUltra early, watching it closely 👀💎${tail}`,`$SAMPLE - 4.2X from entry Nailed the early call, chart exploded 📉${tail}`,`$3.1K → $20K MC = 6.4x 🚀\n\nMy $SAMPLE call.\n\nCalled early. Momentum followed. 🔥\nKeep watching — the next move could be bigger. 👀${tail}`,`🚀 $SAMPLE IS GOING PARABOLIC! 🔥\n\n$2.1K → $20K MC = 9.5x! 💎📈\n\nMy private TG squad keeps catching these monster moves! 🏆 Don’t sleep on the next alpha! 👀💰\n\nCA: ${mint} https://t.co/sample`];
 for(const card of cards){assert.equal(isLowValueTwitterPost(card),true,card);assert.equal(isLowValueTwitterPost(card+'\nThe claim is false. I did not profit.'),false);assert.equal(isLowValueTwitterPost('Nice sarcasm. I would not buy.\n'+card),false);}
});

test('private-group sales pitches and address-only replies are excluded, substantive warnings retained',()=>{
 const cards=[`🚀 $SAMPLE IS PRINTING! 💰🔥\n\nMy Alpha TG fam is catching massive moves! 📈🏆 Copy trading with us means staying in the game.\n\nReady for the next alpha? 👀💎\n\nCA: ${mint} https://t.co/test`,`Secured a massive move with $SAMPLE\n\nEntered at $2.5k, now sitting at $20k, marking an incredible 8x return!\n\nDon't miss the next one-catch these opportunities first in my private TG!\n\nCa: ${mint}\n\n#solana #crypto https://t.co/test`];
 for(const card of cards){assert.equal(isLowValueTwitterPost(card),true);assert.equal(isLowValueTwitterPost(card+'\nI did not profit. This is misleading.'),false);}
 assert.equal(isLowValueTwitterPost('@example solana:'+mint),true);
 assert.equal(isLowValueTwitterPost('Make sure you buy the right token and not a scam one. solana:'+mint),false);
});
