import { createRequire } from 'node:module';
import { requestJSON } from '../../lib/reply/proxy';
const shared = createRequire(__filename)('../../scripts/account-health.cjs');
export interface AccountProxy { type: string; host: string; port: number; username?: string; password?: string; }
export const normalizeProxy: (input: unknown) => AccountProxy | null = shared.normalizeProxy;
export const toPublicProxy: (input: unknown) => Record<string, unknown> | null = shared.toPublicProxy;
export function serializeProxy(input: unknown) { const p=normalizeProxy(input);return p?JSON.stringify(p):null; }
export async function probeProxy(input: unknown) {
 const p=normalizeProxy(input);if(!p)throw new Error('PROXY_FAILED');
 const proxy={server:p.type+'://'+p.host+':'+p.port,username:p.username,password:p.password};
 const start=Date.now();
 const result=await requestJSON(new URL('https://api64.ipify.org?format=json'),{proxy,timeoutMs:10000});
 const ip=(result.data as {ip?:string}).ip;
 if(result.status!==200||!ip||!/^[\da-f:.]+$/i.test(ip))throw new Error('PROXY_FAILED');
 const latency=Date.now()-start;
 let geo:{country?:string;city?:string;timezone?:string}={};
 try { const r=await requestJSON(new URL('https://ipapi.co/'+encodeURIComponent(ip)+'/json/'),{proxy,timeoutMs:5000});
 const d=r.data as {country_code?:string;city?:string;timezone?:string};
 if(r.status===200)geo={country:d.country_code,city:d.city,timezone:d.timezone};
 }catch{/* Geolocation is optional. */}
 return {...p,...geo,ip,latency,status:'connected',last_check:Date.now()};
}
