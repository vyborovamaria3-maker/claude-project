const {normalizeProxy,toPublicProxy}=require('./account-health.cjs');
const {connect,name}=require('./autopost/runtime.cjs');
async function check(input){
 const p=normalizeProxy(input);if(!p)throw Error('PROXY_FAILED');
 try{let probeProxy;try{const {tsImport}=require('tsx/esm/api');({probeProxy}=await tsImport('../src/accounts/proxy.ts',__filename));}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;({probeProxy}=require('../dist/src/accounts/proxy.js'));}return {ok:true,proxy:await probeProxy(p)};}
 catch{return {ok:false,proxy:{...p,status:'failed',last_check:Date.now()}};}
}
async function saveCheckedProxy(c,input,result){
 if(!result.ok)throw Error('PROXY_FAILED');
 if(!name(input.name))throw Error('Invalid account');
 if(input.version===undefined)input.version=(await c.query('SELECT updated_at::text FROM x_accounts WHERE name=$1',[input.name])).rows[0]?.updated_at;
 if(!/^\d+$/.test(String(input.version||'')))throw Error('Invalid account version');
 const now=Date.now();
 const r=await c.query('UPDATE x_accounts SET proxy_json=$2,updated_at=GREATEST(updated_at+1,$3::bigint),health_score=NULL,last_check_json=NULL,last_check_at=NULL WHERE name=$1 AND updated_at=$4::bigint AND account_busy_until<=$3 RETURNING name',[input.name,JSON.stringify(result.proxy),now,input.version]);
 if(!r.rowCount)throw Error('Account busy or changed');
 return {ok:true,proxy:toPublicProxy(result.proxy)};
}
async function main(){
 let data='';if(!process.argv.includes('--test')&&!process.argv.includes('--save'))for await(const part of process.stdin){data+=part;if(data.length>16000)throw Error('Invalid input');}
 const input=data?JSON.parse(data):{proxy:process.argv[process.argv.indexOf('--test')+1]};
 if(process.argv.includes('--save')){input.action='save';input.name=process.argv[process.argv.indexOf('--save')+1];input.proxy=process.argv[process.argv.indexOf('--proxy')+1];}
 const result=await check(input.proxy);
 if(input.action==='save'){
  if(!name(input.name))throw Error('Invalid account');
  if(!result.ok){process.stdout.write(JSON.stringify({ok:false,message:'Прокси не отвечает. Настройки не сохранены.',proxy:toPublicProxy(result.proxy)}));return;}
  const c=await connect();try{await saveCheckedProxy(c,input,result);}finally{await c.end();}
 }
 process.stdout.write(JSON.stringify({ok:result.ok,proxy:toPublicProxy(result.proxy),message:result.ok?'Прокси подключён':'Прокси не отвечает'}));
}
if(require.main===module)main().catch(()=>{process.stdout.write(JSON.stringify({ok:false,message:'Не удалось проверить или сохранить прокси. Проверьте адрес и обновите аккаунты.'}));process.exitCode=1;});
module.exports={check,saveCheckedProxy};
