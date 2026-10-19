#!/usr/bin/env node
'use strict';
const {connect,config}=require('./runtime.cjs');
const {parseKey,audit,rotateDisposableTestDatabase}=require('./key-rotation-core.cjs');
const args=process.argv.slice(2);
const flags=new Set(args);
const rehearsal=flags.has('--apply-test-only');
if(flags.size!==args.length||args.some(x=>!['--dry-run','--apply-test-only','--confirm-backup','--confirm-worker-stopped'].includes(x))||
 flags.has('--dry-run')&&rehearsal||!rehearsal&&(flags.has('--confirm-backup')||flags.has('--confirm-worker-stopped'))){
 console.error('Usage: node scripts/autopost/rotate-keys.cjs [--dry-run] OR --apply-test-only --confirm-backup --confirm-worker-stopped');
 process.exitCode=2;
}else{
 (async()=>{
  let c,oldKey,newKey;
  try{
   const env={...process.env,...config()};
   oldKey=parseKey(env.MASTER_KEY);
   if(rehearsal){
    newKey=parseKey(env.X_COLLECTOR_NEXT_MASTER_KEY);
    if(oldKey.equals(newKey))throw Error('NEW_KEY_MUST_DIFFER');
    if(!/^[A-Za-z0-9_-]{1,48}$/.test(env.X_COLLECTOR_NEXT_KEY_ID||''))throw Error('INVALID_NEW_KEY_ID');
   }
   c=await connect();
   const options={legacyKey:oldKey,nextKey:newKey,nextId:env.X_COLLECTOR_NEXT_KEY_ID,
    confirmedBackup:flags.has('--confirm-backup'),confirmedStopped:flags.has('--confirm-worker-stopped')};
   const result=rehearsal?await rotateDisposableTestDatabase(c,options):await audit(c,options);
   console.log(JSON.stringify({ok:true,...result}));
  }catch(error){
   // Never log the exception message: it may contain a connection string.
   console.error('Key inventory / rehearsal failed; no secrets were printed. Review prerequisites and database logs.');
   process.exitCode=1;
  }finally{
   oldKey?.fill(0);newKey?.fill(0);
   await c?.end().catch(()=>{});
  }
 })();
}
