const VERSION='stored-chain-v1';
const INTS=['records','wallets','buys','sells','other','firstAt','lastAt','modelExampleCount'];
const NUMS=['buySol','sellSol','turnoverSol','netRecordedBuySol','top5TurnoverPct'];
const close=(a,b)=>Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
function bad(){throw Error('invalid_chain_assessment')}
export function projectChainAssessment(raw,tokenId){
 if(!raw||raw.version!==VERSION||raw.tokenId!==tokenId||raw.coverage!=='all-stored-asof;full-chain-unknown'||typeof raw.datasetHash!=='string'||!/^[a-f0-9]{64}$/.test(raw.datasetHash)||raw.evidenceRef!=='chain:stored-dataset:sha256:'+raw.datasetHash)bad();
 const out={version:VERSION,tokenId,coverage:raw.coverage,datasetHash:raw.datasetHash,evidenceRef:raw.evidenceRef};
 for(const k of INTS){if(!Number.isSafeInteger(raw[k])||raw[k]<0)bad();out[k]=raw[k]}
 for(const k of NUMS){if(typeof raw[k]!=='number'||!Number.isFinite(raw[k])||(k!=='netRecordedBuySol'&&raw[k]<0))bad();out[k]=raw[k]}
 if(!out.records||out.records>100000||out.wallets>out.records||out.buys+out.sells+out.other!==out.records||out.firstAt>out.lastAt||out.modelExampleCount>20||out.modelExampleCount>out.records||out.top5TurnoverPct>100+1e-7||!close(out.buySol+out.sellSol,out.turnoverSol)||!close(out.buySol-out.sellSol,out.netRecordedBuySol))bad();
 if(!Array.isArray(raw.topWallets)||raw.topWallets.length>5)bad();
 out.topWallets=raw.topWallets.map(w=>{if(!w||typeof w.wallet!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.wallet)||!Number.isSafeInteger(w.records)||w.records<1||w.records>out.records||!Number.isFinite(w.buySol)||!Number.isFinite(w.sellSol)||w.buySol<0||w.sellSol<0||!Array.isArray(w.signatures)||w.signatures.length>2||w.signatures.some(s=>typeof s!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(s)))bad();return{wallet:w.wallet,records:w.records,buySol:w.buySol,sellSol:w.sellSol,signatures:[...w.signatures]}});
 if(new Set(out.topWallets.map(w=>w.wallet)).size!==out.topWallets.length||out.topWallets.length!==Math.min(5,out.wallets)||out.topWallets.reduce((n,w)=>n+w.records,0)>out.records||!close(out.top5TurnoverPct,out.turnoverSol?out.topWallets.reduce((n,w)=>n+w.buySol+w.sellSol,0)*100/out.turnoverSol:0))bad();
 const allowed=['stored_activity','coverage_unknown',...(out.buySol>out.sellSol?['recorded_buy_excess']:out.sellSol>out.buySol?['recorded_sell_excess']:[]),...(out.top5TurnoverPct>=50?['turnover_concentration']:[]),...(out.lastAt-out.firstAt<86400?['short_observed_window']:[])];
 if(!Array.isArray(raw.findingIds)||raw.findingIds.length>5||new Set(raw.findingIds).size!==raw.findingIds.length||!raw.findingIds.includes('stored_activity')||!raw.findingIds.includes('coverage_unknown')||raw.findingIds.some(id=>!allowed.includes(id)))bad();out.findingIds=[...raw.findingIds];return out;
}
export function chainSummaryLines(s){
 const f=n=>n.toFixed(4),lines=[`Блокчейн: агрегаты по ВСЕМ ${s.records} сохранённым записям / ${s.wallets} кошелькам; ${s.modelExampleCount} отдельных примеров передано модели.`];
 for(const id of s.findingIds){
  if(id==='stored_activity')lines.push(`В сохранённых данных: BUY ${s.buys}, SELL ${s.sells}; сумма записанных BUY ${f(s.buySol)} SOL, SELL ${f(s.sellSol)} SOL.`);
  if(id==='recorded_buy_excess'||id==='recorded_sell_excess')lines.push(`Разница записанных BUY−SELL: ${f(s.netRecordedBuySol)} SOL. Это не прибыль, не остаток ликвидности и не прогноз цены.`);
  if(id==='turnover_concentration')lines.push(`На 5 кошельков приходится ${s.top5TurnoverPct.toFixed(2)}% записанного оборота. Общий владелец из этого не следует.`);
  if(id==='short_observed_window')lines.push(`Сохранённый период: ${((s.lastAt-s.firstAt)/3600).toFixed(2)} ч; это ограниченное окно, а не вся история токена.`);
  if(id==='coverage_unknown')lines.push('Учтены все сохранённые записи на момент запроса; полнота блокчейна и подтверждённое исполнение не доказаны.');
 }
 return lines;
}
