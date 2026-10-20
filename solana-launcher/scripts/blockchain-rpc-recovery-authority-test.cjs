"use strict";
const assert=require("node:assert/strict");
const {mkdtempSync,mkdirSync,copyFileSync,rmSync,linkSync,existsSync,writeFileSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {fork}=require("node:child_process");
const Database=require("better-sqlite3");
const now=Date.UTC(2026,9,20,14);
const binding={eventKey:"chain:synthetic:1",keyId:"test-key",endpointId:"test-source",genesisHash:"1".repeat(32)};
if(process.argv[2]==="--child"){
  process.once("message",data=>{
    if(data.action==="crash-after-sqlite"){
      // Test-only fault injection: stop after the challenge transaction commits,
      // while the separate authority transaction is still pending. No production hooks.
      const low=require("./blockchain-rpc-challenge-store.cjs"),recover=low.recoverRpcChallengeStore;
      low.recoverRpcChallengeStore=(...args)=>{recover(...args);process.exit(23)};
    }
    const {openRpcRecoveryAuthority}=require("./blockchain-rpc-recovery-authority.cjs");
    let authority;
    try{
      authority=openRpcRecoveryAuthority(data.authority,{clock:()=>now});
      let result;
      if(data.action==="begin"||data.action==="crash-after-begin"){
        result=authority.beginRecovery(data.expected);
        if(data.action==="crash-after-begin")process.exit(23);
      }else result=authority.finishRecovery(data.expected,data.previous);
      authority.close();authority=null;
      process.send({result},()=>process.disconnect());
    }catch(error){
      if(authority)authority.close();
      process.send({error:error.message},()=>process.disconnect());
    }
  });
}else{
  const {createRpcRecoveryAuthority,openRpcRecoveryAuthority}=require("./blockchain-rpc-recovery-authority.cjs");
  function child(authority,action,expected,previous){
    return new Promise((resolve,reject)=>{
      const p=fork(__filename,["--child"],{stdio:["ignore","ignore","ignore","ipc"]});
      let received;
      p.on("message",m=>{received=m});p.on("error",reject);
      p.on("exit",code=>{
        if(code===23)return resolve({crashed:true});
        if(code===0&&received)resolve(received);else reject(Error("synthetic_authority_child_failed"));
      });
      p.send({authority,action,expected,previous});
    });
  }
  async function main(){
    const dir=mkdtempSync(join(tmpdir(),"arch06-authority-"));
    mkdirSync(join(dir,"control"));mkdirSync(join(dir,"data"));
    const file=join(dir,"data","challenges.sqlite"),authorityFile=join(dir,"control","generation.sqlite");
    const snapshot=join(dir,"data","snapshot.sqlite"),config={clock:()=>now};
    let authority,store,reader,stale;
    try{
      assert.throws(()=>openRpcRecoveryAuthority(authorityFile,config),/open/);
      assert.equal(existsSync(authorityFile),false,"missing authority never auto-created");
      assert.throws(()=>createRpcRecoveryAuthority(file,{...config,challengeFilename:file}),/separate/);
      authority=createRpcRecoveryAuthority(authorityFile,{...config,challengeFilename:file});
      const initial=authority.status();assert.equal(initial.phase,"active");
      reader=new Database(authorityFile);reader.exec("BEGIN IMMEDIATE");
      assert.throws(()=>authority.beginRecovery(initial.epoch),/locked/);
      reader.exec("ROLLBACK");reader.close();reader=null;
      assert.deepEqual(authority.status(),initial,"failed advance leaves authority unchanged");
      assert.throws(()=>createRpcRecoveryAuthority(authorityFile,{...config,challengeFilename:file}),/EEXIST/);
      assert.throws(()=>authority.openChallenges(),/open/);
      store=authority.createChallenges();
      const spent=store.issue(binding),unused=store.issue(binding),record=c=>({...binding,challenge:c.challenge,now});
      reader=new Database(file);await reader.backup(snapshot);reader.close();reader=null;
      assert.equal(store.consumeChallenge(record(spent)),true);
      stale=authority.openChallenges();
      // Competing recoveries compare the old generation; only one may advance it.
      const races=await Promise.all([1,2].map(()=>child(authorityFile,"begin",initial.epoch)));
      assert.equal(races.filter(r=>r.result?.phase==="recovering").length,1);
      assert.equal(races.filter(r=>r.error).length,1);
      const pending=authority.status();assert.notEqual(pending.epoch,initial.epoch);
      assert.throws(()=>stale.issue(binding),/not_active_or_stale/);
      assert.throws(()=>stale.consumeChallenge(record(unused)),/not_active_or_stale/);
      assert.throws(()=>authority.openChallenges(),/not_active_or_stale/);
      assert.throws(()=>authority.createChallenges(),/not_active_or_stale/);
      stale.close();stale=null;store.close();store=null;authority.close();authority=null;
      copyFileSync(snapshot,file); // all challenge connections closed; authority not restored
      // A failure before SQLite rotation leaves durable authority pending across restart.
      const wrong=await child(authorityFile,"finish",pending.epoch,"0".repeat(64));
      assert.match(wrong.error,/compare_failed/);
      authority=openRpcRecoveryAuthority(authorityFile,config);
      assert.deepEqual(authority.status(),pending);authority.close();authority=null;
      assert.deepEqual(await child(authorityFile,"crash-after-sqlite",pending.epoch,initial.epoch),{crashed:true});
      authority=openRpcRecoveryAuthority(authorityFile,config);
      assert.deepEqual(authority.status(),pending,"crash cannot prematurely activate authority");
      assert.throws(()=>authority.openChallenges(),/not_active_or_stale/);
      authority.close();authority=null;
      const completed=await child(authorityFile,"finish",pending.epoch,initial.epoch);
      assert.equal(completed.result.phase,"active","resume recognizes already committed SQLite generation");
      authority=openRpcRecoveryAuthority(authorityFile,config);store=authority.openChallenges();
      assert.equal(store.consumeChallenge(record(spent)),false);
      assert.equal(store.consumeChallenge(record(unused)),false);
      const fresh=store.issue(binding);assert.equal(store.consumeChallenge(record(fresh)),true);
      // Lost final acknowledgement: completion can be retried without another rotation.
      assert.deepEqual(authority.finishRecovery(pending.epoch,initial.epoch),completed.result);
      store.close();store=null;authority.close();authority=null;
      // Repeat rollback with authority intact: active generation no longer matches DB.
      copyFileSync(snapshot,file);
      authority=openRpcRecoveryAuthority(authorityFile,config);
      assert.throws(()=>authority.openChallenges(),/epoch_mismatch/);
      authority.close();authority=null;
      assert.deepEqual(await child(authorityFile,"crash-after-begin",pending.epoch),{crashed:true});
      authority=openRpcRecoveryAuthority(authorityFile,config);
      const next=authority.status();assert.equal(next.phase,"recovering");
      assert.notEqual(next.epoch,pending.epoch);
      assert.throws(()=>authority.finishRecovery(pending.epoch,initial.epoch),/epoch_mismatch/);
      authority.finishRecovery(next.epoch,initial.epoch);
      store=authority.openChallenges();assert.equal(store.consumeChallenge(record(spent)),false);
      // Same SQLite file via hardlink must never become its own authority.
      const alias=join(dir,"control","alias.sqlite");linkSync(file,alias);
      assert.throws(()=>createRpcRecoveryAuthority(alias,{...config,challengeFilename:file}),/separate/);
      const missing=join(dir,"control","missing.sqlite");
      assert.throws(()=>openRpcRecoveryAuthority(missing,config),/open/);
      const corrupt=join(dir,"control","corrupt.sqlite");writeFileSync(corrupt,"synthetic corruption");
      assert.throws(()=>openRpcRecoveryAuthority(corrupt,config),/database/);
      const empty=join(dir,"data","empty.sqlite"),emptyAuthority=join(dir,"control","empty-generation.sqlite");
      writeFileSync(empty,"");
      const emptyControl=createRpcRecoveryAuthority(emptyAuthority,{...config,challengeFilename:empty});
      try{
        assert.throws(()=>emptyControl.openChallenges(),/dedicated_challenge_schema/,
          "ordinary managed open must not initialize an empty restored file");
        const state=emptyControl.beginRecovery(emptyControl.status().epoch);
        assert.throws(()=>emptyControl.finishRecovery(state.epoch,null),/dedicated_challenge_schema/);
        assert.equal(emptyControl.status().phase,"recovering");
      }finally{emptyControl.close()}
      const foreign=join(dir,"control","foreign.sqlite");reader=new Database(foreign);
      reader.exec("CREATE TABLE synthetic_keep(value TEXT); INSERT INTO synthetic_keep VALUES('keep')");
      assert.throws(()=>openRpcRecoveryAuthority(foreign,config),/dedicated_recovery/);
      assert.equal(reader.prepare("SELECT value FROM synthetic_keep").get().value,"keep");
      reader.close();reader=null;
      console.log("[blockchain-rpc-recovery-authority-test] OK: separate durable authority, concurrent CAS, pending gate, process crashes before/after SQLite commit, resume, repeated rollback and path isolation");
    }finally{
      if(reader)reader.close();if(stale)stale.close();if(store)store.close();if(authority)authority.close();
      rmSync(dir,{recursive:true,force:true});
    }
  }
  main().catch(error=>{console.error(error);process.exitCode=1});
}
