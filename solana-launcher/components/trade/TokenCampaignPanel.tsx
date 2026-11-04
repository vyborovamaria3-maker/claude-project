"use client";
import {useEffect,useState} from "react";
import type {CampaignAssessment} from "@/lib/trade/token-campaigns.mjs";
const pct=(n:number|undefined)=>Number.isFinite(n)?((n as number)*100).toFixed(2)+"%":"—";
const date=(n:number)=>new Date(n).toLocaleString("ru-RU");
const phases:Record<string,string>={after_prior_jump:"После наблюдавшегося роста ≥50%",before_later_growth:"До последующего роста в заданных окнах",later_growth_prior_unknown:"Рост после поста есть, предыстории недостаточно",no_50pct_event:"Порог 50% не пересечён",insufficient_history:"Истории недостаточно"};
export default function TokenCampaignPanel({mint,initialData}:{mint:string;initialData?:CampaignAssessment}){
 const [rawData,setData]=useState<CampaignAssessment|null>(initialData?.mint===mint?initialData:null);const [proofs,setProofs]=useState<Record<string,string>>({});const [error,setError]=useState("");
 const data=rawData?.mint===mint?rawData:null;
 useEffect(()=>{let active=true;const controller=new AbortController();setData(initialData?.mint===mint?initialData:null);setProofs({});setError("");fetch("/api/trade/token-campaigns?mint="+encodeURIComponent(mint),{cache:"no-store",signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();const value=await r.json();if(active&&value.mint===mint)setData(value);}).catch(()=>{if(active)setError("Данные связок временно недоступны");});return()=>{active=false;controller.abort();};},[mint,initialData]);
 async function proof(sha:string){try{const r=await fetch("/api/trade/token-campaigns?mint="+encodeURIComponent(mint)+"&evidence="+sha,{cache:"no-store"});if(!r.ok)throw Error();const value=JSON.stringify(await r.json(),null,2);setProofs(p=>({...p,[sha]:value}));}catch{setError("Ценовое доказательство временно недоступно");}}
 return <section className="glass rounded-xl border border-bg-border p-4 space-y-3" data-testid="token-campaign-panel">
  <h3 className="font-semibold text-white">Связки аккаунтов и время публикаций</h3>
  {error&&<p className="text-sm text-amber-300">{error}</p>}
  {!data&&!error&&<p className="text-sm text-white/60">Проверяю сохранённые данные по этому CA…</p>}
  {data&&!data.available&&<p className="text-sm text-white/60">{data.status==="stale"?"Снимок устарел. Автоматический анализ должен обновить его.":"Сохранённый анализ связок пока недоступен. Это не означает отсутствие групп."}</p>}
  {data?.available&&<>
   <p className="text-sm text-white/70">По этому CA: {data.counts?.groups} групп, {data.counts?.recurringPairs} повторяющихся пар. Цены проверены для {data.counts?.pricedPosts} из {data.counts?.posts} публикаций. Обновлено: {date(data.generatedAt!)}.</p>
   {(data.pairs?.length??0)>0&&<details><summary className="cursor-pointer text-sm">Кто вместе публикует разные CA</summary>{data.pairs?.map(p=><p className="text-xs text-white/70 my-2" key={p.authors.join(":")}>{p.authors.map(a=>"@"+a).join(" / ")} — {p.distinctCa} разных CA, {p.utcDays} UTC-дней. Совпадение не доказывает общего владельца.</p>)}</details>}
   <p className="text-xs text-white/50">Показано {data.records?.length} публикаций; сначала первые сохранённые упоминания участников, включая более ранние посты вне группового окна.</p>
   {data.records?.map(p=><details key={p.tweetId} className="border-t border-white/10 pt-2"><summary className="cursor-pointer text-sm">@{p.author} · {phases[p.phase]??phases.insufficient_history}</summary>
    <a className="text-xs underline" target="_blank" rel="noopener noreferrer" href={"https://x.com/"+encodeURIComponent(p.author)+"/status/"+p.tweetId}>{date(p.postedAt)} · исходный пост</a>
    <p className="text-xs text-white/60">{p.firstStoredMention?"Первое сохранённое упоминание. ":""}{p.earlierContext?"Раньше тесного группового окна.":"В найденной группе."}</p>
    <blockquote className="text-sm whitespace-pre-wrap my-2">{p.text}{p.textTruncated?"… (фрагмент)":""}</blockquote>
    {p.prior&&<p className="text-xs text-white/70">До поста наблюдался рост {pct(p.prior.gain)}: ${p.prior.fromUsd} ({date(p.prior.fromAt)}) → ${p.prior.toUsd} ({date(p.prior.toAt)}). {p.prior.complete24h?"Полное окно 24ч.":"Полнота предыдущих 24ч не подтверждена."}</p>}
    {[1,24,72].map(h=>{const o=p.outcomes[h];return <p key={h} className="text-xs my-1 text-white/70">{h} ч: {o?`${pct(o.netReturn)} с условными издержками; $${o.entryUsd} → $${o.exitUsd}. Объём свечей $${o.entryVolumeUsd.toFixed(2)} / $${o.exitVolumeUsd.toFixed(2)}. ${o.quality==="thin_candle"?"Тонкая свеча — не считать исполнимой доходностью.":"Исполнение сделки не проверено."}`:"Ценового результата нет; это не нулевая доходность."}</p>;})}
    {p.evidenceHash&&<button className="text-xs underline" onClick={()=>proof(p.evidenceHash!)}>Свечи и источник цен</button>}
    {p.evidenceHash&&proofs[p.evidenceHash]&&<pre className="text-xs overflow-auto max-h-72">{proofs[p.evidenceHash]}</pre>}
    <p className="text-xs break-all text-white/40">SHA-256 текста: {p.textHash}</p>
   </details>)}
   {data.limitations?.map(x=><p key={x} className="text-xs text-white/50">{x}</p>)}
  </>}
 </section>;
}
