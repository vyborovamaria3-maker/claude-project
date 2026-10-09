const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const {Client}=require('pg'),dotenv=require('dotenv');
function config(){const p=process.env.X_COLLECTOR_ENV?path.resolve(process.env.X_COLLECTOR_ENV):path.resolve('.env');const e=fs.existsSync(p)?dotenv.parse(fs.readFileSync(p)):{};return {...e,DATABASE_URL:e.DATABASE_URL||process.env.X_COLLECTOR_DATABASE_URL,MASTER_KEY:e.MASTER_KEY||process.env.X_COLLECTOR_MASTER_KEY};}
function key(){const raw=config().MASTER_KEY||'';const k=/^[a-f0-9]{64}$/i.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');if(k.length!==32)throw Error('MASTER_KEY должен содержать 32 байта');return k;}
function seal(value){const k=key();try{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',k,iv);const b=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]);}finally{k.fill(0);}}
function unseal(value){const k=key();try{const d=crypto.createDecipheriv('aes-256-gcm',k,value.subarray(0,12));d.setAuthTag(value.subarray(12,28));return Buffer.concat([d.update(value.subarray(28)),d.final()]).toString('utf8');}finally{k.fill(0);}}
async function connect(){const c=new Client({connectionString:config().DATABASE_URL,connectionTimeoutMillis:5000});await c.connect();return c;}
const name=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v);
const handle=v=>typeof v==='string'&&/^@?[A-Za-z0-9_]{1,15}$/.test(v);
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
module.exports={config,seal,unseal,connect,name,handle,digest};
