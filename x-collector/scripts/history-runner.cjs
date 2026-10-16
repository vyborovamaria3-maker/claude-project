const {setTimeout:delay}=require('node:timers/promises');
const LOCK=742098534;

// Reconnect the producer session, never replay an individual SQL transaction.
// Each new session must own the advisory lock before reading durable progress.
async function runHistoryProducer({open,cycle,isTransient,signal,report=()=>{},sleep=ms=>delay(ms,undefined,{signal})}){
 let client,broken=false,failures=0;
 async function close(){const old=client;client=undefined;if(old)await old.end().catch(()=>{});}
 try{
  while(!signal.aborted){
   try{
    if(!client){
     broken=false;
     client=await open(()=>{broken=true;});
     signal.throwIfAborted();
     if(!(await client.query('SELECT pg_try_advisory_lock('+LOCK+') AS locked')).rows[0].locked)return;
     if(broken)throw Error('Connection terminated unexpectedly');
     failures=0;
     report('ready');
    }
    if(broken)throw Error('Connection terminated unexpectedly');
    await cycle(client);
   }catch(error){
    if(signal.aborted)break;
    if(broken||isTransient(error)){
     await close();failures++;
     report('database_unavailable');
     await sleep(Math.min(30000,1000*2**Math.min(failures-1,5)));
     continue;
    }
    throw error;
   }
   await sleep(10000);
  }
 }catch(error){if(!signal.aborted)throw error;}
 finally{await close();}
}
module.exports={runHistoryProducer};
