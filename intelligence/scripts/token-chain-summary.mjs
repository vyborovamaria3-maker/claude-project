import {createHash} from 'node:crypto';
export const CHAIN_AGGREGATE_VERSION='stored-chain-v1';
export function collectStoredChain(chain,mint,ms){
 const read=()=>{
  // Earlier collectors did not store optional price/slot fields. Preserve their
  // original stored input as null rather than requiring a write migration.
  const columns=new Set(chain.prepare('PRAGMA table_info(token_trades)').all().map(c=>c.name));
  const optional=name=>columns.has(name)?name:`NULL AS ${name}`;
  const statement=chain.prepare(`SELECT signature,timestamp,trader,type,amount_sol,amount_tokens,${optional('price_sol')},${optional('slot')},inserted_at
   FROM token_trades WHERE mint=? AND timestamp<=? AND inserted_at<=? ORDER BY timestamp DESC,signature`);
  const records=statement.iterate?statement.iterate(mint,Math.floor(ms/1000),ms):statement.all(mint,Math.floor(ms/1000),ms);
  const archive=[],sample=[],wallets=new Map(),digest=createHash('sha256');
  digest.update(JSON.stringify([CHAIN_AGGREGATE_VERSION,mint])+'\n');
  let buys=0,sells=0,other=0,buySol=0,sellSol=0,first=null,last=null;
  for(const raw of records){
   if(archive.length>=100000)throw Error('token_chain_dataset_too_large');
   const amount=Number(raw.amount_sol);
   if(!Number.isFinite(amount)||amount<0||!Number.isFinite(Number(raw.timestamp)))throw Error('token_chain_invalid_record');
   const row=[raw.signature,Number(raw.timestamp),raw.trader,raw.type,amount,Number(raw.amount_tokens),raw.price_sol??null,raw.slot??null,raw.inserted_at??null];
   archive.push(row);digest.update(JSON.stringify(row)+'\n');if(sample.length<101)sample.push(raw);
   first=first===null?row[1]:Math.min(first,row[1]);last=last===null?row[1]:Math.max(last,row[1]);
   if(row[3]==='buy'){buys++;buySol+=amount}else if(row[3]==='sell'){sells++;sellSol+=amount}else other++;
   const w=wallets.get(row[2])||{wallet:row[2],records:0,buySol:0,sellSol:0,signatures:[]};w.records++;
   if(row[3]==='buy')w.buySol+=amount;if(row[3]==='sell')w.sellSol+=amount;
   if(w.signatures.length<2)w.signatures.push(row[0]);wallets.set(row[2],w);
  }
  const topWallets=[...wallets.values()].sort((a,b)=>(b.buySol+b.sellSol)-(a.buySol+a.sellSol)||String(a.wallet).localeCompare(String(b.wallet))).slice(0,5);
  const datasetHash=digest.digest('hex'),turnoverSol=buySol+sellSol;
  const summary={version:CHAIN_AGGREGATE_VERSION,tokenId:'solana:'+mint,records:archive.length,wallets:wallets.size,buys,sells,other,buySol,sellSol,turnoverSol,netRecordedBuySol:buySol-sellSol,firstAt:first,lastAt:last,
   top5TurnoverPct:turnoverSol?100*topWallets.reduce((n,w)=>n+w.buySol+w.sellSol,0)/turnoverSol:0,topWallets,datasetHash,evidenceRef:'chain:stored-dataset:sha256:'+datasetHash,coverage:'all-stored-asof;full-chain-unknown'};
  return {sample,archive,summary};
 };
 return typeof chain.transaction==='function'&&!chain.inTransaction?chain.transaction(read).deferred():read();
}
export function eligibleChainFindings(s){return s.records?['stored_activity','coverage_unknown',...(s.buySol>s.sellSol?['recorded_buy_excess']:s.sellSol>s.buySol?['recorded_sell_excess']:[]),...(s.top5TurnoverPct>=50?['turnover_concentration']:[]),...(s.lastAt-s.firstAt<86400?['short_observed_window']:[])]:[];}
export function validateChainFindingIds(ids,s){
 const allowed=eligibleChainFindings(s);
 if(!Array.isArray(ids)||!ids.length||ids.length>5||new Set(ids).size!==ids.length||ids.some(id=>!allowed.includes(id))||!ids.includes('stored_activity')||!ids.includes('coverage_unknown'))throw Error('token_chain_findings_invalid');
 return [...ids];
}
export const CHAIN_PROMPT=' Additional schema for this request: include chainFindingIds, an array of 2..5 exact IDs from eligibleChainFindingIds, always including stored_activity and coverage_unknown. chainSummary aggregates ALL qualifying stored rows, not just the trades examples. Select only observations justified by its numbers. Amounts are recorded SOL turnover, never profit, liquidity, common ownership, manipulation proof or future returns. The archive hash identifies the full stored input snapshot, not verified blockchain settlement. Keep the original required social fields and factIds unchanged; no free-form blockchain claims.';

export function chainArchiveHash(mint,rows){const h=createHash('sha256');h.update(JSON.stringify([CHAIN_AGGREGATE_VERSION,mint])+'\n');for(const row of rows)h.update(JSON.stringify(row)+'\n');return h.digest('hex');}

export const CHAIN_ONLY_PROMPT='Analyze the supplied chainSummary of ALL stored records and the illustrative trades. Return ONLY one JSON object with exactly the key chainFindingIds: an array of2..5 exact IDs from eligibleChainFindingIds. Always include stored_activity and coverage_unknown. Select additional IDs only if justified by the supplied aggregate values. Do not output sentiment, prose, confidence, profit, forecasts, ownership or manipulation claims. All-stored records do not prove full blockchain coverage or final settlement.';
