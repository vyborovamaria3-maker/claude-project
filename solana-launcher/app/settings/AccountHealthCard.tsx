'use client';
import {useEffect,useState,type ReactNode} from 'react';
export type HealthAccount={
 name:string;role:string;status:string;tier:string;updated_at:string;account_busy_until:string;
 weight_used_this_hour:number;weight_quota_per_hour:number;total_requests:string;total_errors:string;
 user_agent?:string|null;timezone?:string|null;language?:string|null;display_name?:string|null;
 health_score?:number|null;last_check_at?:string|null;sessionState?:string;
 proxy?:{type:string;host:string;port:number;username?:string;hasPassword?:boolean;status:string;country?:string;city?:string;latency?:number;ipMasked?:string;ipVersion?:number}|null;
 lastError?:{type:string;message:string}|null;
 lastCheck?:Check|null;
};
type Check={id?:string;status:string;steps?:Record<string,{status:string;message?:string}>;score?:number;ready?:boolean;message?:string};
type History={id:string;status:string;since_date:string;until_date:string;message:string;authors:number;posts:number;total:number;done:number;errors:number;lists:{list_id:string;status:string}[]};
const labels:Record<string,string>={database:'База',session:'Сессия',proxy:'Прокси',browser:'Браузер',x:'X'};
async function command(input:unknown){
 const response=await fetch('/api/integrations/x-collector',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),cache:'no-store'});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'Запрос не выполнен');return result;
}
export default function AccountHealthCard({account,onSaved,children}:{account:HealthAccount;onSaved:()=>Promise<void>;children:ReactNode}){
 const [settings,setSettings]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [proxyType,setProxyType]=useState(account.proxy?.type||'http'),[proxyInput,setProxyInput]=useState('');
 const [ua,setUa]=useState(account.user_agent||''),[timezone,setTimezone]=useState(account.timezone||''),[language,setLanguage]=useState(account.language||'');
 const [probe,setProbe]=useState<any>(null),[check,setCheck]=useState<Check|null>(null);
 const [parsing,setParsing]=useState<{ids:string[];running:boolean;message:string}|null>(null);
 const [history,setHistory]=useState<History|null>(null);
 useEffect(()=>{
  if(account.role!=='collector')return;let stopped=false;
  const refresh=()=>{void command({action:'account-history-status',name:account.name}).then(result=>{if(!stopped)setHistory(result.run);}).catch(()=>{});};
  refresh();const timer=setInterval(refresh,10000);
  return()=>{stopped=true;clearInterval(timer);};
 },[account.name,account.role]);
 const parsingIds=parsing?.ids,parsingRunning=parsing?.running;
 const locked=busy||check?.status==='running'||Number(account.account_busy_until)>Date.now();
 useEffect(()=>{
  if(!check?.id||check.status!=='running')return;
  let stopped=false;const id=check.id;
  const timer=setInterval(()=>{void command({action:'account-check-status',id}).then(async result=>{if(stopped)return;setCheck(result);if(result.status!=='running')await onSaved();}).catch(e=>{if(!stopped){setError(e.message);setCheck({status:'failed',message:e.message});}});},1000);
  return()=>{stopped=true;clearInterval(timer);};
 },[check?.id,check?.status,onSaved]);
 useEffect(()=>{
  if(!parsingRunning||!parsingIds)return;let stopped=false;
  const timer=setInterval(()=>{void command({action:'account-parse-status',name:account.name,ids:parsingIds}).then(result=>{
   if(stopped)return;
   const done=result.tasks.filter((t:{status:string})=>t.status==='done').length;
   const failed=result.tasks.filter((t:{status:string})=>['failed','dlq','cancelled'].includes(t.status)).length;
   setParsing(current=>current?{...current,running:result.running,message:result.running?'Сбор выполняется: '+done+'/'+parsingIds.length+' списков. Ожидание зависит от квоты аккаунта.':'Сбор завершён: '+done+'/'+parsingIds.length+' списков; ошибок: '+failed}:current);
   if(!result.running)void onSaved();
  }).catch(e=>{if(!stopped){setError(e.message);setParsing(current=>current?{...current,running:false}:current);}});},2000);
  return()=>{stopped=true;clearInterval(timer);};
 },[parsingRunning,parsingIds,account.name,onSaved]);
 async function perform(action:string){
  setBusy(true);setError('');
  try{
   if(action==='account-check-start'){setCheck(await command({action,name:account.name}));return;}
   if(action.startsWith('account-history-')){const result=await command({action,name:account.name,id:history?.id});setHistory(result.run);return;}
   if(action==='account-parse-start'){const result=await command({action,name:account.name});setParsing({ids:result.ids,running:true,message:result.message});return;}
   const proxy=proxyInput.includes('://')?proxyInput:proxyType+'://'+proxyInput;
   const result=await command({action,name:account.name,version:account.updated_at,proxy,user_agent:ua,timezone,language});
   if(action==='account-proxy-test'||action==='account-proxy-save'){setProbe(result);if(!result.ok){setError(result.message);return;}}
   if(action!=='account-proxy-test'){setCheck(null);setProxyInput('');setSettings(false);await onSaved();}
  }catch(e){setError(e instanceof Error?e.message:'Ошибка проверки');}finally{setBusy(false);}
 }
 const visible=check||account.lastCheck;
 const session=account.sessionState==='valid'?'🟢 Действует':account.sessionState==='expired'?'🔴 Истекла':'🟡 Не проверена';
 const proxy=account.proxy;
 return <article className="rounded-xl border border-white/15 bg-white/5 p-4 text-sm text-white">
  <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="font-semibold">{account.display_name||account.name}</h4><p className="text-xs text-white/50">{account.name} · {account.role} · {account.status} · {account.tier}</p></div><strong>Здоровье: {account.health_score==null?'не проверено':account.health_score+'/100'}</strong></div>
  <div className="my-3 grid gap-2 sm:grid-cols-2"><p>Сессия: {session}</p><p>Прокси: {!proxy?'⚪ Не задан':proxy.status==='connected'?'🟢 Подключён':proxy.status==='failed'?'🔴 Ошибка':'🟡 Не проверен'}{proxy&&<span className="block text-xs text-white/60">{proxy.type} · {proxy.country||'страна неизвестна'} {proxy.city||''} · {proxy.ipVersion?'IPv'+proxy.ipVersion+' · ':''}{proxy.ipMasked||'IP неизвестен'}{proxy.latency!=null?' · '+proxy.latency+' мс':''}</span>}</p><p>Квота в час: {account.weight_used_this_hour} / {account.weight_quota_per_hour}</p><p>Запросы: {account.total_requests} · Ошибки: {account.total_errors}</p></div>
  {account.lastError&&<p className="mb-3 text-amber-200">Последняя ошибка (история): {account.lastError.type}: {account.lastError.message}</p>}
  <div className="flex flex-wrap gap-2"><button type="button" disabled={locked} onClick={()=>void perform('account-check-start')} className="rounded-lg border border-neon-green/40 px-3 py-2 text-neon-green disabled:opacity-40">{check?.status==='running'?'Проверяем…':'Полная проверка'}</button><button type="button" disabled={locked} onClick={()=>{setSettings(true);setUa(account.user_agent||'');setTimezone(account.timezone||'');setLanguage(account.language||'');setProxyInput('');setProbe(null);setError('');}} className="rounded-lg border border-white/30 px-3 py-2 disabled:opacity-40">Настроить</button>{children}</div>
  {error&&<p role="alert" className="mt-3 text-red-300">{error}</p>}
  {account.role==='collector'&&<button type="button" disabled={busy||parsing?.running||account.status!=='active'} onClick={()=>void perform('account-parse-start')} className="mt-3 rounded-lg border border-neon-green/40 px-3 py-2 text-neon-green disabled:opacity-40">{parsing?.running?'Парсинг выполняется…':'Запустить парсинг'}</button>}
  {parsing&&<p role="status" className="mt-2 text-white/70">{parsing.message}</p>}
  {account.role==='collector'&&<div className="mt-3 rounded-lg border border-white/15 p-3">
   <button type="button" disabled={busy||history?.status==='running'||history?.status==='paused'||account.status!=='active'} onClick={()=>void perform('account-history-start')} className="rounded-lg border border-neon-green/40 px-3 py-2 text-neon-green disabled:opacity-40">Архив за 2 года</button>
   <p className="mt-2 text-xs text-white/60">Все доступные публикации участников списков, плюс поиск по мемкоинам, мемам, политике, Маску и Трампу на русском и английском.</p>
   {history&&<div role="status" className="mt-2 space-y-1">
    <p>{history.since_date} — {new Date(Date.parse(history.until_date+'T00:00:00Z')-86400000).toISOString().slice(0,10)} · {history.status==='running'?'сбор идёт':history.status==='paused'?'пауза':'поиск завершён'}</p>
    <p>Авторов: {history.authors} · записей в базе: {history.posts} · периодов обработано: {history.done}/{history.total} · ошибок/неполных периодов: {history.errors}</p>
    <p className="text-xs text-white/60">{history.message}</p>
    {history.lists.some(l=>l.status==='failed')&&<p className="text-amber-200">Часть списков участников не загрузилась. Охват авторов неполный.</p>}
    <p className="text-xs text-white/50">Прогресс сохраняется. Учитывается квота аккаунта; поиск X не гарантирует полноту архива.</p>
    {history.status!=='finished'&&<button type="button" disabled={busy} onClick={()=>void perform(history.status==='paused'?'account-history-resume':'account-history-pause')} className="rounded border border-white/30 px-3 py-1">{history.status==='paused'?'Продолжить архив':'Приостановить архив'}</button>}
    {(history.errors>0||history.lists.some(l=>l.status==='failed'))&&<button type="button" disabled={busy} onClick={()=>void perform('account-history-retry')} className="ml-2 rounded border border-white/30 px-3 py-1">Повторить ошибки</button>}
   </div>}
  </div>}
  {visible&&<div role="status" className="mt-3 rounded-lg border border-white/10 p-3"><p>Проверка: {visible.score??0}/100 · {visible.status==='running'?'выполняется':visible.ready?'готов к работе':'есть проблемы'}</p><div className="mt-2 flex flex-wrap gap-3">{Object.entries(visible.steps||{}).map(([key,step])=><span key={key} title={step.message}>{labels[key]||key}: {({passed:'✓',failed:'✕',running:'…',pending:'ожидание',skipped:'пропущен'} as Record<string,string>)[step.status]||step.status}</span>)}</div>{visible.message&&<p>{visible.message}</p>}{Object.entries(visible.steps||{}).filter(([,s])=>s.status==='failed').map(([key,s])=><p key={key} className="mt-1 text-red-300">{labels[key]}: {s.message}</p>)}</div>}
  {settings&&<div role="dialog" aria-modal="true" aria-label={'Настройки '+account.name} className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4"><div className="my-auto w-full max-w-xl space-y-4 rounded-xl border border-white/20 bg-slate-950 p-5">
   <h3 className="text-lg font-semibold">Настройки {account.name}</h3>
   <p className="text-white/60">Текущий прокси: {proxy?proxy.type+'://'+proxy.host+':'+proxy.port:'не задан'}. Пароль сохранённого прокси скрыт.</p>
   <label className="block">Тип<select aria-label="Тип прокси" value={proxyType} onChange={e=>setProxyType(e.target.value)} className="ml-3 rounded bg-slate-800 p-2">{['http','https','socks5'].map(t=><option key={t} value={t}>{t.toUpperCase()}</option>)}</select></label>
   <p className="text-xs text-white/60">Для IPv6 заключите адрес в квадратные скобки: [2001:db8::1]:8080. Этот прокси используется только данным аккаунтом.</p>
   <label className="block">Новый прокси<input type="password" autoComplete="new-password" value={proxyInput} onChange={e=>{setProxyInput(e.target.value);setProbe(null);}} placeholder="user:pass@host:port или user:pass@[IPv6]:port" className="mt-1 w-full rounded border border-white/20 bg-slate-900 p-2"/></label>
   <div className="flex flex-wrap gap-2"><button disabled={busy||!proxyInput.trim()} onClick={()=>void perform('account-proxy-test')} className="rounded border border-white/20 p-2 disabled:opacity-40">TEST</button><button disabled={busy||!proxyInput.trim()} onClick={()=>void perform('account-proxy-save')} className="rounded border border-neon-green/40 p-2 text-neon-green disabled:opacity-40">Проверить и сохранить прокси</button>{proxy&&<button disabled={busy} onClick={()=>void perform('account-proxy-remove')} className="rounded border border-white/20 p-2">Убрать прокси</button>}</div>
   {probe&&<p role="status">{probe.message}{probe.proxy?.status==='connected'?' · '+(probe.proxy.country||'страна неизвестна')+' · '+probe.proxy.ipMasked+' · '+probe.proxy.latency+' мс':''}</p>}
   {(['User-Agent','Часовой пояс','Язык'] as const).map((label,i)=><label key={label} className="block">{label}<input value={[ua,timezone,language][i]} onChange={e=>[setUa,setTimezone,setLanguage][i](e.target.value)} placeholder={['По умолчанию','Europe/Moscow','ru-RU'][i]} className="mt-1 w-full rounded border border-white/20 bg-slate-900 p-2"/></label>)}
   {error&&<p role="alert" className="text-red-300">{error}</p>}
   <div className="flex gap-2"><button disabled={busy} onClick={()=>void perform('account-settings-save')} className="rounded border border-neon-green/40 p-2 text-neon-green disabled:opacity-40">Сохранить настройки</button><button disabled={busy} onClick={()=>{setSettings(false);setProxyInput('');}} className="rounded border border-white/20 p-2">Закрыть</button></div>
  </div></div>}
 </article>;
}
