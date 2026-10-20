"use strict";
const assert=require("node:assert/strict");
const {mkdtempSync,rmSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {Worker,isMainThread,parentPort,workerData}=require("node:worker_threads");
const {fork}=require("node:child_process");
const Database=require("better-sqlite3");
const {openRpcChallengeStore}=require("./blockchain-rpc-challenge-store.cjs");
const binding={eventKey:"chain:synthetic:revision:1",keyId:"test-key",
  endpointId:"test-endpoint",genesisHash:"1".repeat(32)};
const now=Date.UTC(2026,9,20,12);

if(process.argv[2]==="--restart-child"){
  process.once("message",data=>{
    const store=openRpcChallengeStore(data.file,{clock:()=>now});
    const value=data.issue?store.issue(binding):store.consumeChallenge(data.record);
    if(data.crashAfterCommit)process.exit(23); // lost acknowledgement, no clean close
    store.close();process.send({value},()=>process.disconnect());
  });
}else if(!isMainThread){
  const store=openRpcChallengeStore(workerData.file,{clock:()=>now});
  if(workerData.barrier){
    const barrier=new Int32Array(workerData.barrier);
    parentPort.postMessage({ready:true});
    Atomics.wait(barrier,0,0);
  }
  const value=workerData.issue?store.issue(binding):store.consumeChallenge(workerData.record);
  store.close();parentPort.postMessage({value});
}else{
  function processRun(file,options={}){
    return new Promise((resolve,reject)=>{
      const child=fork(__filename,["--restart-child"],{stdio:["ignore","ignore","ignore","ipc"]});
      let value,received=false;
      child.on("message",m=>{value=m.value;received=true});
      child.on("error",reject);
      child.on("exit",code=>{
        if(options.crashAfterCommit&&code===23)return resolve("crashed_after_commit");
        if(code===0&&received)resolve(value);else reject(Error("synthetic_child_failed"));
      });
      child.send({file,...options});
    });
  }
  function worker(file,options={}){
    let ready;
    const started=new Promise(resolve=>{ready=resolve});
    const done=new Promise((resolve,reject)=>{
      const w=new Worker(__filename,{workerData:{file,...options}});
      let value,received=false;
      w.on("message",m=>{if(m.ready)ready();else{value=m.value;received=true}});
      w.on("error",reject);
      w.on("exit",code=>code===0&&received?resolve(value):reject(Error("synthetic_worker_failed")));
    });
    return {started,done};
  }
  async function main(){
    const dir=mkdtempSync(join(tmpdir(),"arch06-challenge-")),file=join(dir,"challenges.sqlite");
    let store,other;
    try{
      assert.throws(()=>openRpcChallengeStore("relative.sqlite"),/absolute/);
      store=openRpcChallengeStore(file,{clock:()=>now});
      const first=store.issue(binding);
      assert.match(first.challenge,/^[a-f0-9]{64}$/);
      const record={...binding,challenge:first.challenge,now};
      for(const [field,value] of [["eventKey","other"],["keyId","other"],
        ["endpointId","other"],["genesisHash","2".repeat(32)],
        ["challenge","0".repeat(64)],["now",now-1],["now",now+1]]){
        assert.equal(store.consumeChallenge({...record,[field]:value}),false,field);
      }
      assert.equal(store.consumeChallenge(record),true);
      store.close();store=openRpcChallengeStore(file,{clock:()=>now});
      assert.equal(store.consumeChallenge(record),false,"consumption survives reopen");
      const pending=store.issue(binding);store.close();store=null;
      assert.equal(await processRun(file,{record:{...binding,challenge:pending.challenge,now}}),true,
        "unused challenge survives issuer exit");
      assert.equal(await processRun(file,{record:{...binding,challenge:pending.challenge,now}}),false,
        "consumption survives process exit/restart");
      const lost=await processRun(file,{issue:true});
      const lostRecord={...binding,challenge:lost.challenge,now};
      assert.equal(await processRun(file,{record:lostRecord,crashAfterCommit:true}),"crashed_after_commit");
      assert.equal(await processRun(file,{record:lostRecord}),false,"commit survives lost ACK/crash");
      const issued=await processRun(file,{issue:true});
      const concurrent={...binding,challenge:issued.challenge,now};
      const barrier=new SharedArrayBuffer(4);
      const a=worker(file,{record:concurrent,barrier}),b=worker(file,{record:concurrent,barrier});
      await Promise.all([a.started,b.started]);
      Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0,2);
      assert.deepEqual((await Promise.all([a.done,b.done])).sort(),[false,true],"one concurrent winner");
      let clock=now;
      store=openRpcChallengeStore(file,{clock:()=>clock});
      const expiring=store.issue(binding,10);clock=now+10;
      assert.equal(store.consumeChallenge({...binding,challenge:expiring.challenge,now}),false,
        "expiry uses store clock even when verifier time is stale");
      clock=now;
      for(const ttl of [0,-1,300001,1.5])assert.throws(()=>store.issue(binding,ttl),/ttl/);
      assert.throws(()=>store.issue({...binding,endpointId:"https://secret.invalid"}),/binding/);
      const locked=store.issue(binding);
      other=new Database(file);other.exec("BEGIN IMMEDIATE");
      assert.throws(()=>store.consumeChallenge({...binding,challenge:locked.challenge,now}),/locked/);
      other.exec("ROLLBACK");other.close();other=null;
      assert.equal(store.consumeChallenge({...binding,challenge:locked.challenge,now}),true,
        "failed lock attempt did not consume");
      other=new Database(file);
      assert.throws(()=>other.exec("UPDATE rpc_challenges SET consumed_at=NULL"),/immutable/);
      assert.throws(()=>other.exec("DELETE FROM rpc_challenges"),/retained/);
      assert.throws(()=>other.exec("INSERT OR REPLACE INTO rpc_challenges SELECT * FROM rpc_challenges LIMIT 1"),/exists/);
      assert(!JSON.stringify(other.prepare("SELECT * FROM rpc_challenges").all()).includes(first.challenge),
        "store retains hashes, not plaintext nonces");
      other.close();other=null;
      const foreign=join(dir,"foreign.sqlite");other=new Database(foreign);
      other.exec("CREATE TABLE synthetic_source(value TEXT); INSERT INTO synthetic_source VALUES('keep')");
      assert.throws(()=>openRpcChallengeStore(foreign),/dedicated_challenge_schema/);
      assert.equal(other.prepare("SELECT value FROM synthetic_source").get().value,"keep");
      assert.equal(other.pragma("journal_mode",{simple:true}),"delete");
      other.close();other=null;
      console.log("[blockchain-rpc-challenge-store-test] OK: temporary durable SQLite, binding, expiry, worker restart, concurrent CAS, lock failure and replay fencing");
    }finally{
      if(other)other.close();if(store)store.close();
      rmSync(dir,{recursive:true,force:true});
    }
  }
  main().catch(error=>{console.error(error);process.exitCode=1});
}
