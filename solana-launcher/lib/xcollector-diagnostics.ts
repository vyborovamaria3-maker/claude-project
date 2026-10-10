import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {AccountError} from './xcollector-accounts';
export function collectorRoot(){
 const root=[path.resolve(process.cwd(),'../x-collector'),path.resolve(process.cwd(),'x-collector')].find(p=>fs.existsSync(path.join(p,'scripts/account-check.cjs')));
 if(!root)throw new AccountError('Установите обновление X Collector',503);
 return root;
}
type Check={id:string;name:string;status:string;created:number;steps?:Record<string,{status:string;message?:string}>;score?:number;ready?:boolean;message?:string};
const shared=globalThis as typeof globalThis & {xcAccountChecks?:Map<string,Check>};
const checks=shared.xcAccountChecks??(shared.xcAccountChecks=new Map());
const historyShared=globalThis as typeof globalThis & {xcHistoryChild?:ReturnType<typeof spawn>};
export function ensureHistoryCollector(){
 if(historyShared.xcHistoryChild&&historyShared.xcHistoryChild.exitCode===null&&!historyShared.xcHistoryChild.killed)return;
 const root=collectorRoot();
 const child=spawn(process.execPath,[path.join(root,'scripts/history-collector.cjs')],{cwd:root,env:{...process.env},stdio:['ignore','ignore','ignore','ipc'],shell:false,windowsHide:true});
 historyShared.xcHistoryChild=child;
 child.on('error',()=>{if(historyShared.xcHistoryChild===child)historyShared.xcHistoryChild=undefined;});
 child.on('exit',()=>{if(historyShared.xcHistoryChild===child)historyShared.xcHistoryChild=undefined;});
}
export function accountCheckStatus(id:unknown){const check=typeof id==='string'?checks.get(id):null;if(!check)throw new AccountError('Проверка завершена или сервер перезапущен. Запустите заново',404);return check;}
export function startAccountCheck(input:any){
 if(typeof input?.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.name))throw new AccountError('Некорректное имя аккаунта');
 for(const [id,check] of checks)if(Date.now()-check.created>15*60000)checks.delete(id);
 if([...checks.values()].filter(c=>c.status==='running').length>=3||[...checks.values()].some(c=>c.status==='running'&&c.name===input.name))throw new AccountError('Проверка уже выполняется. Дождитесь результата',409);
 const root=collectorRoot(),id=randomUUID(),check:Check={id,name:input.name,status:'running',created:Date.now()};checks.set(id,check);
 const child=spawn(process.execPath,[path.join(root,'scripts/account-check.cjs'),input.name,'--json'],{cwd:root,env:{...process.env},stdio:['ignore','ignore','ignore','ipc'],shell:false,windowsHide:true});
 const timer=setTimeout(()=>{if(check.status==='running'){check.status='failed';check.message='Проверка превысила три минуты';child.kill();}},180000);timer.unref();
 child.on('message',(value:any)=>{
  if(check.status!=='running'||!value||!['running','done','failed'].includes(value.status))return;
  // Only fields from our bounded, redacted diagnostic protocol are forwarded.
  check.status=value.status;check.steps=value.steps;check.score=value.score;check.ready=value.ready;check.message=value.message;
  if(check.status!=='running')clearTimeout(timer);
 });
 child.on('error',()=>{check.status='failed';check.message='Не удалось запустить проверку';clearTimeout(timer);});
 child.on('exit',()=>{clearTimeout(timer);if(check.status==='running'){check.status='failed';check.message='Проверка прервана';}});
 return check;
}
export async function accountProxyCommand(input:any){
 if(typeof input?.proxy!=='string'||!input.proxy.trim()||input.proxy.length>12000)throw new AccountError('Укажите строку прокси');
 if(input.action==='account-proxy-save'&&(typeof input.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.name)||!/^\d+$/.test(input.version)))throw new AccountError('Обновите аккаунты перед сохранением');
 const root=collectorRoot();
 return new Promise<any>((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'scripts/proxy-check.cjs')],{cwd:root,env:{...process.env},stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true});
  let output='',settled=false;
  const finish=(error?:Error,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
  const timer=setTimeout(()=>{child.kill();finish(new AccountError('Прокси не ответил за 30 секунд',504));},30000);
  child.stdout.on('data',part=>{output+=part.toString();if(output.length>16000){child.kill();finish(new AccountError('Некорректный ответ проверки',503));}});
  child.on('error',()=>finish(new AccountError('Не удалось запустить проверку',503)));
  child.on('close',()=>{try{const result=JSON.parse(output);if(typeof result.ok!=='boolean')throw Error();finish(undefined,result);}catch{finish(new AccountError('Проверка не вернула результат',503));}});
  child.stdin.on('error',()=>finish(new AccountError('Проверка прервана',503)));
  child.stdin.end(JSON.stringify({action:input.action==='account-proxy-save'?'save':'test',name:input.name,version:input.version,proxy:input.proxy}));
 });
}
