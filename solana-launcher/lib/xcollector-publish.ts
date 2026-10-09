import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {AccountError} from './xcollector-accounts';
type Job={id:string;name:string;status:string;message:string;url?:string;created:number};
const shared=globalThis as typeof globalThis & {xcPublishJobs?:Map<string,Job>};
const jobs=shared.xcPublishJobs??(shared.xcPublishJobs=new Map());
export function publishStatus(id:unknown){const job=typeof id==='string'?jobs.get(id):undefined;if(!job)throw new AccountError('Публикация не найдена. Проверьте профиль X перед повтором.',404);return {...job};}
export function startPublish(input:any){
 if(typeof input.id!=='string'||!/^[a-f0-9-]{36}$/i.test(input.id))throw new AccountError('Некорректный ID публикации');
 if(typeof input.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.name)||typeof input.expected!=='string'||!/^@?[A-Za-z0-9_]{1,15}$/.test(input.expected))throw new AccountError('Укажите имя сессии и username аккаунта');
 if(typeof input.text!=='string'||!input.text.trim()||Array.from(input.text).length>280)throw new AccountError('Текст: 1–280 символов');
 if(jobs.has(input.id))return publishStatus(input.id);
 if([...jobs.values()].some(j=>['opening','sending'].includes(j.status)))throw new AccountError('Дождитесь текущей публикации',409);
 const root=[path.resolve(process.cwd(),'../x-collector'),path.resolve(process.cwd(),'x-collector')].find(p=>fs.existsSync(path.join(p,'scripts/x-publish-web.cjs')));
 if(!root)throw new AccountError('Установите скрипт публикации в x-collector',503);
 if(jobs.size>200)throw new AccountError('Перезапустите сайт после проверки результатов публикаций',503);
 const job:Job={id:input.id,name:input.name,status:'opening',message:'Открываем X и проверяем профиль…',created:Date.now()};jobs.set(job.id,job);
 const child=spawn(process.execPath,[path.join(root,'scripts/x-publish-web.cjs')],{cwd:root,env:{...process.env},stdio:['ignore','ignore','ignore','ipc'],shell:false});
 const timer=setTimeout(()=>{if(['opening','sending'].includes(job.status)){job.status=job.status==='sending'?'uncertain':'failed';job.message='Время ожидания истекло. Проверьте профиль X перед повтором.';child.kill();}},180000);timer.unref?.();
 child.on('message',(m:any)=>{if(!['opening','sending'].includes(job.status)||!['sending','done','failed','uncertain'].includes(m?.status))return;job.status=m.status;job.message=typeof m.message==='string'?m.message:'Состояние изменилось';if(m.status==='done'&&typeof m.url==='string'&&/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(m.url))job.url=m.url;if(!['opening','sending'].includes(job.status))clearTimeout(timer);});
 child.on('error',()=>{job.status='failed';job.message='Не удалось запустить скрипт публикации';clearTimeout(timer);});
 child.on('exit',()=>{clearTimeout(timer);if(['opening','sending'].includes(job.status)){job.status=job.status==='sending'?'uncertain':'failed';job.message='Процесс остановлен. Проверьте профиль X перед повтором.';}});
 child.send({name:input.name,expected:input.expected,text:input.text},err=>{if(err){job.status='failed';job.message='Не удалось передать текст публикации';child.kill();}});
 return {...job};
}
