'use client';
import PublisherMetrics from './PublisherMetrics';
import {useEffect,useState,type FormEvent} from 'react';
type Account={name:string;updated_at:string};
type Metrics={posts:number;views:string;likes:string;replies:string;retweets:string;last_updated:string|null};
type Day={day:string;posts:number;views:string;likes:string;replies:string;retweets:string};
type Post={tweet_id:string;text:string;url:string|null;posted_at:string;views:string;likes:string;replies:string;retweets:string;updated_at:string};
type Stats={account:{name:string;publisher_handle:string|null};needsHandle:boolean;summary?:Metrics;series?:Day[];posts?:Post[];page:number;pageSize:number;days:number};
const metricLabels={posts:'Посты',views:'Просмотры',likes:'Лайки',replies:'Ответы',retweets:'Репосты'};
type Metric=keyof typeof metricLabels;
const number=(v:string|number|null)=>{if(v===null)return 'Нет данных';try{return BigInt(v).toLocaleString('ru-RU');}catch{return '—';}};
const date=(v:string|null)=>v?new Date(Number(v)).toLocaleString('ru-RU'):'—';
function Chart({series,metrics,title}:{series:Day[];metrics:Metric[];title:string}) {
 const colors=['#4ade80','#60a5fa','#fbbf24'];
 const max=Math.max(1,...series.flatMap(day=>metrics.map(metric=>Number(day[metric]))));
 return <section className="rounded-xl border border-white/10 p-4 min-w-0"><h4 className="text-sm font-semibold text-white">{title}</h4><div className="my-2 flex flex-wrap gap-3 text-xs">{metrics.map((metric,i)=><span key={metric} style={{color:colors[i]}}>{metricLabels[metric]}</span>)}</div><svg viewBox="0 0 600 180" role="img" aria-label={title} className="w-full"><title>{title}</title>{[0,1,2].map(i=><g key={i}><line x1="52" x2="585" y1={20+i*60} y2={20+i*60} stroke="#ffffff20"/><text x="48" y={24+i*60} textAnchor="end" fill="#aaaaaa" fontSize="10">{Intl.NumberFormat('ru-RU',{notation:'compact'}).format(max*(1-i/2))}</text></g>)}{metrics.map((metric,index)=><polyline key={metric} fill="none" stroke={colors[index]} strokeWidth="2.5" points={series.filter(day=>day[metric]!==null).map((day)=>`${52+series.indexOf(day)*533/Math.max(series.length-1,1)},${140-Number(day[metric])/max*120}`).join(' ')} />)}<text x="52" y="169" fill="#aaaaaa" fontSize="11">{series[0]?.day}</text><text x="585" y="169" textAnchor="end" fill="#aaaaaa" fontSize="11">{series.at(-1)?.day}</text></svg></section>;
}
export default function PublisherAccountDashboard({account,onClose,onSaved}:{account:Account;onClose:()=>void;onSaved:()=>Promise<void>}) {
 const [days,setDays]=useState(30),[page,setPage]=useState(1),[data,setData]=useState<Stats|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[handle,setHandle]=useState(''),[saving,setSaving]=useState(false),[revision,setRevision]=useState(0);
 useEffect(()=>{
  const abort=new AbortController();setLoading(true);setError('');setData(null);
  void (async()=>{try{
   const params=new URLSearchParams({action:'publisher-stats',name:account.name,days:String(days),page:String(page)});
   const response=await fetch('/api/integrations/x-collector?'+params,{cache:'no-store',signal:abort.signal});const result=await response.json();if(!response.ok)throw Error(result.error||'Не удалось загрузить статистику');
   if(!abort.signal.aborted){setData(result);setHandle(result.account.publisher_handle||'');}
  }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Ошибка загрузки');}finally{if(!abort.signal.aborted)setLoading(false);}})();
  return()=>abort.abort();
 },[account.name,account.updated_at,days,page,revision]);
 async function save(event:FormEvent){event.preventDefault();if(saving)return;setSaving(true);setError('');try{
  const response=await fetch('/api/integrations/x-collector',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'publisher-profile',name:account.name,version:account.updated_at,handle})});const result=await response.json();if(!response.ok)throw Error(result.error||'Не удалось сохранить профиль');await onSaved();setPage(1);setRevision(v=>v+1);
 }catch(e){setError(e instanceof Error?e.message:'Ошибка сохранения');}finally{setSaving(false);}}
 const series:Day[]=[];
 if(data?.series){const byDay=new Map(data.series.map(day=>[day.day,day]));const today=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'});const midnight=Date.parse(today+'T00:00:00Z');for(let i=days;i>=0;i--){const day=new Date(midnight-i*86400000).toISOString().slice(0,10);series.push(byDay.get(day)??{day,posts:0,views:'0',likes:'0',replies:'0',retweets:'0'});}}
 return <section className="rounded-xl border border-neon-green/30 p-5 space-y-5" aria-label={`Статистика ${account.name}`}>
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-semibold text-white">{account.name}{data?.account.publisher_handle?' · @'+data.account.publisher_handle:''}</h3><p className="text-xs text-white/50">Собственные посты аккаунта публикации из базы X Collector.</p></div><div className="flex flex-wrap gap-3"><select aria-label="Период статистики" value={days} onChange={e=>{setDays(Number(e.target.value));setPage(1);}} className="rounded border border-white/20 bg-black p-2 text-white">{[7,30,90].map(n=><option key={n} value={n}>{n} дней</option>)}</select><button type="button" disabled={loading||saving} onClick={()=>setRevision(v=>v+1)} className="text-neon-green disabled:opacity-40">Обновить</button><button type="button" onClick={onClose} className="text-white/60">Закрыть</button></div></div>
  {error&&<p role="alert" className="text-red-300">{error}</p>}{loading&&<p role="status" className="text-white/60">Загружаем статистику…</p>}
  {data&&<form onSubmit={save} className="flex flex-wrap items-end gap-3"><label className="text-sm text-white">@username этого аккаунта<input required pattern="@?[A-Za-z0-9_]{1,15}" value={handle} onChange={e=>setHandle(e.target.value)} disabled={saving} placeholder="@username" className="mt-1 block rounded border border-white/20 bg-black/20 p-2" /></label><button type="submit" disabled={saving} className="rounded border border-neon-green/40 px-3 py-2 text-neon-green disabled:opacity-40">{saving?'Сохраняем…':'Сохранить привязку'}</button><p className="text-xs text-white/40">Укажите собственный профиль этой сессии. Имя сессии не считается @username.</p></form>}
  {data?.needsHandle&&<p className="text-white/60">Привяжите @username, чтобы загрузить посты и метрики.</p>}
  {data?.account.publisher_handle&&<PublisherMetrics name={account.name} handle={data.account.publisher_handle}/>}
  {data?.summary&&<><div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{(Object.keys(metricLabels) as Metric[]).map(metric=><article key={metric} className="rounded-xl border border-white/10 p-4"><p className="text-xs text-white/50">{metricLabels[metric]}</p><p className="mt-1 text-xl font-semibold text-white">{number(data.summary![metric])}</p></article>)}</div>
   <p className="text-xs text-white/50">Срез метрик постов, опубликованных за выбранный период. Графики группируют текущие показатели по дате публикации (МСК); это не история прироста. Последнее обновление метрик в базе: {date(data.summary.last_updated)}.</p>
   {!data.summary.posts?<p className="rounded border border-white/10 p-4 text-white/60">В базе нет постов этого профиля за выбранный период. Импортируйте пост по ссылке в блоке выше и дождитесь исполнителя.</p>:<><div className="grid gap-4 lg:grid-cols-3"><Chart title="Публикации по дням" series={series} metrics={['posts']}/><Chart title="Просмотры постов" series={series} metrics={['views']}/><Chart title="Взаимодействия с постами" series={series} metrics={['likes','replies','retweets']}/></div>
   <h4 className="font-semibold text-white">Посты аккаунта · {number(data.summary.posts)}</h4><div className="overflow-x-auto"><table className="w-full text-left text-sm text-white"><thead><tr>{['Дата','Пост','Просмотры','Лайки','Ответы','Репосты'].map(label=><th key={label} className="px-2 py-3">{label}</th>)}</tr></thead><tbody>{data.posts?.map(post=><tr key={post.tweet_id} className="border-t border-white/10"><td className="px-2 py-3 whitespace-nowrap">{date(post.posted_at)}</td><td className="px-2 py-3 min-w-64 max-w-lg"><p className="whitespace-pre-wrap break-words">{post.text}</p><a href={'https://x.com/'+data.account.publisher_handle+'/status/'+encodeURIComponent(post.tweet_id)} target="_blank" rel="noopener noreferrer" className="text-blue-400">Открыть в X</a></td>{(['views','likes','replies','retweets'] as const).map(metric=><td key={metric} className="px-2 py-3">{number(post[metric])}</td>)}</tr>)}</tbody></table></div><div className="flex items-center gap-3 text-sm text-white"><button type="button" disabled={page===1||loading} onClick={()=>setPage(v=>v-1)} className="disabled:opacity-40">Назад</button><span>Страница {page} из {Math.max(1,Math.ceil(data.summary.posts/20))}</span><button type="button" disabled={page*20>=data.summary.posts||loading} onClick={()=>setPage(v=>v+1)} className="disabled:opacity-40">Далее</button></div></>}
  </>}
 </section>;
}
