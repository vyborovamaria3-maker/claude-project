"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Database } from "lucide-react";

type Pnl = {wallet:string;mint:string;status:string;coverageComplete:boolean;buys:number;sells:number;
 totalRealizedPnlSol:number|null;unknownReasons:string[]};
type Trade = {signature:string;wallet:string;side?:string;kind?:string;
 amount_tokens?:number|null;amount_sol?:number|null;program?:string};
type Evidence = {mode:"mint"|"wallet";mint?:string;wallet?:string;
 meta:{coverage:string;globallyComplete:boolean;forensicIndexAvailable:boolean;dexIndexAvailable:boolean;
 dexPrograms:Array<{address:string;backfill_complete:number;possible_gap:number}>};
 pnl?:Pnl[];walletPnl?:Pnl[];activities?:Trade[];
 observedDexTrades?:Trade[];seedWalletTrades?:Trade[];note:string};

const display=(value:number|null|undefined)=>
 value==null||!Number.isFinite(value)?"Неизвестно":value.toLocaleString("ru-RU",{maximumFractionDigits:8});
const short=(addr:string)=>addr.length>18?addr.slice(0,7)+"…"+addr.slice(-7):addr;

export default function ForensicEvidencePage() {
 const params=useSearchParams();
 const initial=params.get("mint")||params.get("wallet")||"";
 const [mode,setMode]=useState<"mint"|"wallet">(params.has("wallet")?"wallet":"mint");
 const [address,setAddress]=useState(initial);
 const [result,setResult]=useState<Evidence|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [loading,setLoading]=useState(false);
 const load=useCallback(async(kind:"mint"|"wallet",value:string)=>{
   if(!value.trim()){setResult(null);return;}
   setLoading(true);setError(null);setResult(null);
   try{
     const r=await fetch("/api/blockchain/evidence?"+kind+"="+encodeURIComponent(value.trim())+"&limit=100",{cache:"no-store"});
     const data=await r.json() as Evidence & {error?:string};
     if(!r.ok)throw new Error(data.error||"HTTP "+r.status);
     setResult(data);
   }catch(e){setError(e instanceof Error?e.message:"Ошибка чтения локальной базы");}
   finally{setLoading(false);}
 },[]);
 useEffect(()=>{if(initial)void load(params.has("wallet")?"wallet":"mint",initial);},[initial,load,params]);
 const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();void load(mode,address);};
 const pnls=result?.mode==="wallet"?result.pnl:result?.walletPnl;
 const trades=result?.mode==="wallet"?result.activities:result?.observedDexTrades;
 return <section className="space-y-5 text-white" data-tag="trade.analysis.onchain.evidence">
  <header className="space-y-2">
   <h1 className="text-xl font-semibold">Доказательства Solana</h1>
   <p className="text-sm text-white/60">Реальные транзакции из локального SQLite-кэша Helius. Excel — только источник адресов, не подтверждение прибыли.</p>
  </header>
  <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4 sm:flex-row">
   <select value={mode} onChange={e=>setMode(e.target.value as "mint"|"wallet")} className="rounded-md border border-white/15 bg-neutral-900 px-3 py-2 text-sm" aria-label="Объект анализа">
    <option value="mint">Токен (mint)</option><option value="wallet">Кошелёк</option>
   </select>
   <input value={address} onChange={e=>setAddress(e.target.value)} placeholder="Адрес Solana base58" className="min-w-0 flex-1 rounded-md border border-white/15 bg-neutral-900 px-3 py-2 text-sm" aria-label="Адрес токена или кошелька"/>
   <button disabled={loading} className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50">{loading?"Чтение…":"Показать доказательства"}</button>
  </form>
  {error&&<p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-200">{error}</p>}
  {result&&<>
   <div className="rounded-lg border border-amber-400/30 bg-amber-500/5 p-4">
    <div className="flex items-center gap-2 text-sm font-medium text-amber-200"><AlertTriangle size={16}/> Охват частичный. Это не полная история рынка.</div>
    <p className="mt-2 text-xs text-white/70">Показаны только кошельки, историю которых собирали, и наблюдения настроенных DEX-программ. Перевод между адресами не доказывает общего владельца.</p>
    <div className="mt-2 flex flex-wrap gap-4 text-xs text-white/60">
     <span>DEX-программ: {result.meta.dexPrograms.length}</span>
     <span>Индекс кошельков: {result.meta.forensicIndexAvailable?"есть":"не создан"}</span>
     <span>Индекс DEX: {result.meta.dexIndexAvailable?"есть":"не создан"}</span>
    </div>
   </div>
   <div className="rounded-xl border border-white/10 p-4">
    <h2 className="mb-3 flex items-center gap-2 text-base font-medium"><Database size={16}/> PnL по подтверждённым событиям</h2>
    {!pnls?.length?<p className="text-sm text-white/50">Для этого адреса подтверждённых расчётов пока нет.</p>:
    <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs">
     <thead className="border-b border-white/15 text-white/50"><tr><th className="p-2">Кошелёк</th><th className="p-2">Токен</th><th className="p-2">Покупки/продажи</th><th className="p-2">PnL, SOL</th><th className="p-2">Статус</th><th className="p-2">Причины</th></tr></thead>
     <tbody>{pnls.map((p,i)=><tr key={p.wallet+":"+p.mint+":"+i} className="border-b border-white/5">
      <td className="p-2 font-mono" title={p.wallet}>{short(p.wallet)}</td><td className="p-2 font-mono" title={p.mint}>{short(p.mint)}</td><td className="p-2">{p.buys}/{p.sells}</td>
      <td className="p-2">{p.status==="verified"&&p.coverageComplete?display(p.totalRealizedPnlSol):"Неизвестно"}</td>
      <td className="p-2">{p.status==="verified"&&p.coverageComplete?"Подтверждено":"Неполно"}</td>
      <td className="p-2 text-white/50">{p.unknownReasons.join(", ")||"—"}</td>
     </tr>)}</tbody></table></div>}
   </div>
   <div className="rounded-xl border border-white/10 p-4">
    <h2 className="mb-3 flex items-center gap-2 text-base font-medium"><Database size={16}/> Наблюдаемые операции ({trades?.length||0})</h2>
    {!trades?.length?<p className="text-sm text-white/50">Операции пока не индексированы. Запустите локальный сборщик.</p>:
    <div className="overflow-x-auto"><table className="w-full min-w-[580px] text-left text-xs"><thead className="border-b border-white/15 text-white/50"><tr>
     <th className="p-2">Подпись</th><th className="p-2">Кошелёк</th><th className="p-2">Действие</th><th className="p-2">Токены</th><th className="p-2">SOL</th>
     </tr></thead><tbody>{trades.map((t,i)=><tr key={t.signature+":"+t.wallet+":"+i} className="border-b border-white/5">
      <td className="p-2"><a className="underline underline-offset-2" href={"https://solscan.io/tx/"+encodeURIComponent(t.signature)} target="_blank" rel="noreferrer">{short(t.signature)}</a></td>
      <td className="p-2 font-mono" title={t.wallet}>{short(t.wallet)}</td><td className="p-2">{t.side||t.kind||"—"}</td>
      <td className="p-2">{display(t.amount_tokens)}</td><td className="p-2">{display(t.amount_sol)}</td>
     </tr>)}</tbody></table></div>}
   </div>
   {result.mode==="mint"&&<p className="text-xs text-white/50">Сделок из seed-кошельков: {result.seedWalletTrades?.length||0}. Наблюдения разных DEX-программ дедуплицированы. Число всех покупателей и продавцов токена неизвестно.</p>}
  </>}
 </section>;
}
