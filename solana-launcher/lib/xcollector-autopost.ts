import {spawn} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';
import {AccountError} from './xcollector-accounts';
export function autopostCommand(input:Record<string,unknown>):Promise<any>{
 const root=[path.resolve(process.cwd(),'../x-collector'),path.resolve(process.cwd(),'x-collector')].find(p=>fs.existsSync(path.join(p,'scripts/autopost/engine.cjs')));if(!root)throw new AccountError('Установите пакет автопостинга',503);
 return new Promise((resolve,reject)=>{let settled=false;const child=spawn(process.execPath,[path.join(root,'scripts/autopost/engine.cjs')],{cwd:root,env:{...process.env},stdio:['ignore','ignore','ignore','ipc'],shell:false});
 const finish=(error:Error|null,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};
 const timer=setTimeout(()=>finish(new AccountError('Время запроса истекло. Проверьте очередь перед повторной отправкой.',504)),70000);timer.unref?.();
 child.on('message',(m:any)=>{if(m?.ok===true)finish(null,m.result);else if(m?.ok===false)finish(new AccountError(typeof m.error==='string'?m.error:'Ошибка автопостинга',400));});
 child.on('error',()=>finish(new AccountError('Не удалось запустить модуль автопостинга',503)));child.on('exit',()=>{if(!settled)finish(new AccountError('Модуль автопостинга остановлен. Проверьте очередь.',503));});child.send(input,e=>{if(e)finish(new AccountError('Не удалось передать запрос',503));});
 });
}
export function publicPublishJob(j:any){return {id:j.id,status:j.status==='queued'?'opening':j.status==='running'?'sending':j.status==='published'?'done':j.status==='cancelled'?'failed':j.status,message:j.message||(j.status==='queued'?'В очереди. Запустите autopost-worker.cjs.':'Выполняем публикацию…'),url:j.result_url||undefined};}
