// Shared by diagnostics, collector and publishing worker. Never return raw errors.
function normalizeProxy(input){
 if(input==null||input==='')return null;
 let raw=input;
 if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{/* URL */}}
 let value,username,password;
 if(typeof raw==='string')value=raw.trim();
 else if(raw&&typeof raw==='object'){
  const type=String(raw.type||raw.protocol||'http').replace(/:$/,'').toLowerCase();
  const host=typeof raw.host==='string'&&raw.host.includes(':')&&!raw.host.startsWith('[')?'['+raw.host+']':raw.host;
  value=raw.server||type+'://'+(host||'')+':'+(raw.port||'');
  username=raw.username;password=raw.password;
 }else throw Error('Invalid proxy format');
 if(!value.includes('://'))value='http://'+value;
 let u;try{u=new URL(value);}catch{throw Error('Invalid proxy format');}
 const type=u.protocol.slice(0,-1);
 const port=Number(u.port||({http:80,https:443,socks5:1080,socks4:1080})[type]);
 if(!['http','https','socks5','socks4'].includes(type)||!u.hostname||!Number.isInteger(port)||port<1||port>65535||!['','/'].includes(u.pathname)||u.search||u.hash)throw Error('Invalid proxy format');
 if(username!==undefined&&typeof username!=='string'||password!==undefined&&typeof password!=='string')throw Error('Invalid proxy credentials');
 let user,pass;try{user=username??decodeURIComponent(u.username);pass=password??decodeURIComponent(u.password);}catch{throw Error('Invalid proxy credentials');}
 return {type,host:u.hostname,port,...(user?{username:user}:{}),...(pass?{password:pass}:{})};
}
function playwrightProxy(input){const p=normalizeProxy(input);return p?{server:p.type+'://'+p.host+':'+p.port,...(p.username?{username:p.username}:{}),...(p.password?{password:p.password}:{})}:undefined;}
function toPublicProxy(input){
 if(!input)return null;
 let metadata={};try{metadata=typeof input==='string'?JSON.parse(input):input;}catch{/* URL */}
 let p;try{p=normalizeProxy(input);}catch{return {status:'failed',type:null,host:null,port:null,hasPassword:false};}
 if(!p)return null;
 const clean=(v,n=120)=>typeof v==='string'?v.slice(0,n):null;
 const ip=clean(metadata.ip);
 return {type:p.type,host:p.host,port:p.port,username:p.username||null,hasPassword:Boolean(p.password),country:clean(metadata.country),city:clean(metadata.city),timezone:clean(metadata.timezone),latency:Number.isFinite(metadata.latency)?metadata.latency:null,status:['connected','failed'].includes(metadata.status)?metadata.status:'unverified',last_check:Number.isFinite(metadata.last_check)?metadata.last_check:null,ipVersion:ip?require('node:net').isIP(ip):null,ipMasked:ip?(ip.includes('.')?ip.split('.').slice(0,2).join('.')+'.*.*':ip.split(':').slice(0,2).join(':')+':*'):null};
}
const messages={SESSION_EXPIRED:'Сессия X истекла или не содержит действующих cookies. Войдите заново.',PROXY_FAILED:'Прокси не отвечает. Проверьте VPN, адрес и порт.',X_BLOCKED:'X требует проверки аккаунта или ограничил доступ.',RATE_LIMIT:'X ограничил частоту запросов. Дождитесь снятия ограничения.',BROWSER_ERROR:'Не удалось запустить или использовать браузер.',OTHER:'Проверка не выполнена. Проверьте доступность X и настройки аккаунта.'};
function classifyError(error){const m=String(error?.message||error);if(/SESSION_EXPIRED|AUTH_REQUIRED|auth_token|ct0|session.*(?:expired|decrypt)|MASTER_KEY|\/login/i.test(m))return 'SESSION_EXPIRED';if(/PROXY_FAILED|ERR_PROXY|ERR_TUNNEL|socks|proxy|ECONNREFUSED/i.test(m))return 'PROXY_FAILED';if(/RATE_LIMIT|429|rate.?limit/i.test(m))return 'RATE_LIMIT';if(/X_BLOCKED|captcha|challenge|suspend|403|access.?denied/i.test(m))return 'X_BLOCKED';if(/browsermissing|browserconfig|executable|browser.*closed|Target.*closed|BROWSER_ERROR/i.test(m))return 'BROWSER_ERROR';return 'OTHER';}
async function recordAccountError(c,name,error){const type=classifyError(error);await c.query('INSERT INTO xc_account_errors(account_name,type,message,created_at) VALUES($1,$2,$3,$4)',[name,type,messages[type],Date.now()]);return type;}
function computeScore(steps,hasProxy){const weights={database:10,session:25,proxy:15,browser:15,x:35};const score=Object.entries(weights).reduce((n,[key,w])=>n+(steps[key]?.status==='passed'||key==='proxy'&&!hasProxy&&steps.proxy?.status==='skipped'&&steps.database?.status==='passed'?w:0),0);return {score,ready:['database','session','browser','x'].every(key=>steps[key]?.status==='passed')&&(!hasProxy||steps.proxy?.status==='passed')};}
module.exports={normalizeProxy,playwrightProxy,toPublicProxy,classifyError,recordAccountError,computeScore,messages};
