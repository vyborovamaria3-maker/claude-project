"use client";

import Link from "next/link";
import {useEffect,useRef,useState} from "react";

type Evidence={
  source:"x"|"tg"|"blockchain";
  evidenceId:string;
  observedAt:string;
  occurredAt:string|null;
  kind?:string;
  verification?:string;
};
type TokenIntelResponse={
  schemaVersion:"potapoff-token-intelligence-v1";
  tokenId:string;
  knownAt:string;
  occurredBefore:string;
  historicalCompleteness:"unknown";
  coverage:string;
  truncated:boolean;
  items:Evidence[];
  linkState?:string;
  editDeleteCoverage?:string;
};
function localNow(){
  const date=new Date();
  return new Date(date.getTime()-date.getTimezoneOffset()*60_000)
    .toISOString().slice(0,16);
}
function formatDate(value:string|null){
  if(!value)return "Неизвестно";
  const date=new Date(value);
  return Number.isFinite(date.getTime())?
    date.toLocaleString("ru-RU"):"Неизвестно";
}
function asUtc(value:string){
  if(!value)throw new Error("Укажите обе временные границы.");
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))throw new Error("Некорректная дата.");
  return date.toISOString();
}
function safelyIdentifyMint(input:string){
  // This is UI-level input hygiene only; authoritative Solana PublicKey
  // validation happens in the authenticated Next.js route.
  const mint=input.trim();
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)){
    throw new Error("Введите полный Solana mint-адрес (Base58), а не тикер.");
  }
  return mint;
}
async function readResource(
  mint:string,resource:"links"|"timeline",knownAt:string,
  occurredBefore:string,signal:AbortSignal,
):Promise<TokenIntelResponse>{
  const params=new URLSearchParams({knownAt,occurredBefore,limit:"50"});
  const result=await fetch(
    "/api/intelligence/token/"+encodeURIComponent(mint)+"/"+resource+"?"+params,
    {signal,cache:"no-store",credentials:"same-origin"},
  );
  if(!result.ok){
    const message=result.status===401||result.status===403?
      "Нужна авторизация и доступ к POTAPoff.":
      result.status===429?"Превышен лимит запросов. Повторите позже.":
      result.status===400?"Некорректный адрес или временные границы.":
      result.status===503?"Token Intelligence недоступен. Проверьте локальный API и разрешения.":
      "Не удалось получить данные Token Intelligence.";
    throw new Error(message);
  }
  const data:TokenIntelResponse=await result.json();
  if(data.schemaVersion!=="potapoff-token-intelligence-v1"||
     !Array.isArray(data.items)){
    throw new Error("Получен неподдерживаемый формат ответа.");
  }
  return data;
}
const sourceLabel=(source:string)=>source==="tg"?"Telegram":
  source==="x"?"X":"Blockchain";
function EvidenceList({title,items,empty}:{
  title:string;items:Evidence[]|null;empty:string;
}){
  return <section className="surface-panel space-y-3 p-4">
    <h2 className="text-lg font-semibold">{title}</h2>
    {items===null?<p className="text-content-muted">
      Выполните поиск, чтобы получить данные.
    </p>:items.length===0?
      <p className="text-content-muted">{empty}</p>:
      <ul className="divide-y divide-white/10">
        {items.map((item,index)=><li key={item.evidenceId+":"+index} className="space-y-1 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{sourceLabel(item.source)}</strong>
            {item.kind?<span className="text-content-muted">{item.kind}</span>:null}
          </div>
          <p className="break-all font-mono text-xs text-content-muted">
            Доказательство: {item.evidenceId}
          </p>
          <p>Событие: {formatDate(item.occurredAt)}</p>
          <p>Стало известно: {formatDate(item.observedAt)}</p>
          {item.verification?<p className="text-content-muted">
            Mint проверен через исходный RPC-резолвер.
          </p>:null}
        </li>)}
      </ul>}
  </section>;
}
export default function TokenIntelligencePage(){
  const [mint,setMint]=useState("");
  const [knownAt,setKnownAt]=useState("");
  const [occurredBefore,setOccurredBefore]=useState("");
  const [selected,setSelected]=useState("");
  const [data,setData]=useState<{timeline:TokenIntelResponse;links:TokenIntelResponse}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    const value=localNow();
    setKnownAt(value);
    setOccurredBefore(value);
    return ()=>controller.current?.abort();
  },[]);
  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    controller.current?.abort();
    const pending=new AbortController();
    controller.current=pending;
    setBusy(true);setError("");setData(null);setSelected("");
    try{
      const id=safelyIdentifyMint(mint);
      const observedCutoff=asUtc(knownAt);
      const eventCutoff=asUtc(occurredBefore);
      if(eventCutoff>observedCutoff||observedCutoff>new Date().toISOString()){
        throw new Error("Время события не может быть позже времени знания или будущего.");
      }
      const [timeline,links]=await Promise.all([
        readResource(id,"timeline",observedCutoff,eventCutoff,pending.signal),
        readResource(id,"links",observedCutoff,eventCutoff,pending.signal),
      ]);
      if(pending.signal.aborted)return;
      setData({timeline,links});setSelected(id);
    }catch(cause){
      if(!pending.signal.aborted){
        setError(cause instanceof Error?cause.message:"Не удалось загрузить аналитику.");
      }
    }finally{
      if(controller.current===pending){
        controller.current=null;setBusy(false);
      }
    }
  }
  return <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
    <nav className="flex flex-wrap items-center gap-4 text-sm">
      <Link href="/intelligence" className="text-primary">← Все сущности</Link>
      <Link href="/settings" className="text-content-muted">Настройки</Link>
    </nav>
    <header className="space-y-2">
      <h1 className="text-2xl font-bold">Token Intelligence · X / Telegram / Blockchain</h1>
      <p className="text-content-muted">
        Проверенные исторические наблюдения по точному Solana mint.
        Адрес токена — не тикер и не адрес кошелька. Доступна только
        информация, известная на заданный момент.
      </p>
    </header>
    <form onSubmit={submit} className="surface-panel grid gap-4 p-4 md:grid-cols-2">
      <label className="md:col-span-2">
        <span className="mb-2 block text-sm font-medium">Solana mint-адрес</span>
        <input value={mint} onChange={e=>setMint(e.target.value)}
          required maxLength={44} spellCheck={false} autoComplete="off"
          placeholder="Полный Base58 mint, например So111..."
          className="w-full rounded border border-white/20 bg-transparent p-3 font-mono text-sm"/>
      </label>
      <label>
        <span className="mb-2 block text-sm">События до (местное время)</span>
        <input type="datetime-local" required value={occurredBefore}
          onChange={e=>setOccurredBefore(e.target.value)}
          className="w-full rounded border border-white/20 bg-transparent p-3"/>
      </label>
      <label>
        <span className="mb-2 block text-sm">Известно на (местное время)</span>
        <input type="datetime-local" required value={knownAt}
          onChange={e=>setKnownAt(e.target.value)}
          className="w-full rounded border border-white/20 bg-transparent p-3"/>
      </label>
      <div className="md:col-span-2 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy}
          className="rounded border border-white/25 bg-white/10 px-5 py-3 disabled:opacity-50">
          {busy?"Загрузка…":"Показать доказательства"}
        </button>
        <span className="text-sm text-content-muted">
          Не выполняет сделки, скрейпинг или RPC-запросы.
        </span>
      </div>
    </form>
    {error?<p role="alert" className="rounded border border-red-500/40 p-3 text-red-400">{error}</p>:null}
    {busy?<p role="status">Получение подтверждённых данных…</p>:null}
    {selected&&data?<section className="surface-panel space-y-2 p-4">
      <h2 className="font-semibold">Состояние аналитики</h2>
      <p className="break-all font-mono text-sm">{data.timeline.tokenId}</p>
      <p>Историческая полнота: <strong>неизвестна</strong>.</p>
      <p className="text-content-muted">
        Показаны только наблюдения в пределах доступного покрытия источников.
        Отсутствие записей не доказывает отсутствия публикаций или сделок.
      </p>
      {data.timeline.truncated||data.links.truncated?
        <p className="text-amber-300">Достигнут лимит 50 записей в одной из выборок.</p>:null}
      <p className="text-content-muted">
        Старые изменения и удаления X/TG до включения отслеживания
        могут отсутствовать в истории. Нет подтверждения полной on-chain
        истории, оценки риска или доходности.
      </p>
    </section>:null}
    <div className="grid gap-6 lg:grid-cols-2">
      <EvidenceList title="Timeline — события токена"
        items={data?.timeline.items??null}
        empty="За выбранный период в доступной истории событий не найдено."/>
      <EvidenceList title="Подтверждённые связи — X и Telegram"
        items={data?.links.items??null}
        empty="Актуальных подтверждённых связей на выбранный момент не найдено."/>
    </div>
  </main>;
}
