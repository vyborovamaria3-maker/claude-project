import {spawn,type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {AccountError} from './xcollector-accounts';
type Login={id:string;name:string;role:string;status:'opening'|'waiting'|'saving'|'done'|'failed'|'cancelled';message:string;created:number;child:ChildProcess|null;timer:ReturnType<typeof setTimeout>|null};
const shared=globalThis as typeof globalThis & {xcWebLogins?:Map<string,Login>};
const logins=shared.xcWebLogins??(shared.xcWebLogins=new Map());
const publicState=(login:Login)=>({id:login.id,name:login.name,status:login.status,message:login.message});
function find(id:unknown){if(typeof id!=='string')throw new AccountError('Неизвестная сессия входа',404);const login=logins.get(id);if(!login)throw new AccountError('Сессия входа завершена. Начните заново',404);return login;}
function stop(login:Login){if(login.timer)clearTimeout(login.timer);login.timer=null;login.child?.kill();}
export function loginStatus(id:unknown){return publicState(find(id));}
export function startAccountLogin(input:any){
 if(typeof input?.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.name))throw new AccountError('Имя: 1–64 латинских буквы, цифры, _ или -');
 if(!['collector','publisher'].includes(input?.role))throw new AccountError('Неизвестная роль');
 const now=Date.now();for(const [id,l] of logins){if(now-l.created>15*60000){stop(l);logins.delete(id);}}
 if([...logins.values()].some(l=>['opening','waiting','saving'].includes(l.status)))throw new AccountError('Уже открыт вход в X. Завершите или отмените его',409);
 const roots=[path.resolve(process.cwd(),'../x-collector'),path.resolve(process.cwd(),'x-collector')];
 const root=roots.find(p=>fs.existsSync(path.join(p,'scripts/x-login-web.cjs')));if(!root)throw new AccountError('Установите scripts/x-login-web.cjs в x-collector',503);
 const id=crypto.randomUUID();
 const login:Login={id,name:input.name,role:input.role,status:'opening',message:'Открываем браузер…',created:now,child:null,timer:null};logins.set(id,login);
 const child=spawn(process.execPath,[path.join(root,'scripts/x-login-web.cjs'),input.name,input.role],{cwd:root,env:{...process.env},stdio:['ignore','ignore','ignore','ipc'],shell:false});login.child=child;
 child.on('message',(message:any)=>{
  if(!message||!['waiting','saving','done','failed'].includes(message.status)||!['opening','waiting','saving'].includes(login.status))return;
  login.status=message.status;login.message=typeof message.message==='string'?message.message:'Состояние входа изменилось';
  if(['done','failed'].includes(login.status)){if(login.timer)clearTimeout(login.timer);login.timer=null;}
 });
 child.on('error',()=>{login.status='failed';login.message='Не удалось запустить вход. Проверьте Node.js и зависимости X Collector';stop(login);});
 child.on('exit',()=>{login.child=null;if(['opening','waiting','saving'].includes(login.status)){login.status='failed';login.message='Окно входа закрыто. Начните заново';}if(login.timer)clearTimeout(login.timer);login.timer=null;});
 login.timer=setTimeout(()=>{if(['opening','waiting','saving'].includes(login.status)){login.status='failed';login.message='Время входа истекло (10 минут). Начните заново';stop(login);}},10*60000);login.timer.unref?.();
 return publicState(login);
}
export function finishAccountLogin(id:unknown){const login=find(id);if(login.status!=='waiting'||!login.child?.connected)throw new AccountError('Дождитесь открытия браузера',409);login.status='saving';login.message='Проверяем вход и сохраняем сессию…';login.child.send({action:'finish'},error=>{if(error){login.status='failed';login.message='Связь с браузером потеряна';stop(login);}});return publicState(login);}
export function cancelAccountLogin(id:unknown){const login=find(id);if(login.status==='saving')throw new AccountError('Дождитесь окончания сохранения',409);if(['done','failed','cancelled'].includes(login.status))return publicState(login);login.status='cancelled';login.message='Вход отменён';stop(login);return publicState(login);}
