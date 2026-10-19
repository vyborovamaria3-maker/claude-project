const fs=require('node:fs'),path=require('node:path'),nodeCrypto=require('node:crypto');
const {Client}=require('pg'),dotenv=require('dotenv');
const {sealBytes,unsealBytes}=require('./keyring.cjs');
function config(){
 const filePath=process.env.X_COLLECTOR_ENV?path.resolve(process.env.X_COLLECTOR_ENV):path.resolve('.env');
 const file=fs.existsSync(filePath)?dotenv.parse(fs.readFileSync(filePath)):{};
 return {...process.env,...file,
  DATABASE_URL:file.DATABASE_URL||process.env.X_COLLECTOR_DATABASE_URL,
  MASTER_KEY:file.MASTER_KEY||process.env.X_COLLECTOR_MASTER_KEY||process.env.MASTER_KEY,
  X_COLLECTOR_ENCRYPTION_KEYS:file.X_COLLECTOR_ENCRYPTION_KEYS||process.env.X_COLLECTOR_ENCRYPTION_KEYS,
  X_COLLECTOR_ACTIVE_KEY_ID:file.X_COLLECTOR_ACTIVE_KEY_ID||process.env.X_COLLECTOR_ACTIVE_KEY_ID};
}
function seal(value){
 const plain=Buffer.from(value,'utf8');
 try{return sealBytes(plain,config());}finally{plain.fill(0);}
}
function unseal(value){
 const plain=unsealBytes(value,config());
 try{return plain.toString('utf8');}finally{plain.fill(0);}
}
async function connect({onError}={}){
 const c=new Client({connectionString:config().DATABASE_URL,connectionTimeoutMillis:5000});
 if(onError)c.on('error',onError);
 try{await c.connect();return c;}catch(error){await c.end().catch(()=>{});throw error;}
}
const name=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v);
const handle=v=>typeof v==='string'&&/^@?[A-Za-z0-9_]{1,15}$/.test(v);
const digest=s=>nodeCrypto.createHash('sha256').update(s).digest('hex');
module.exports={config,seal,unseal,connect,name,handle,digest};
