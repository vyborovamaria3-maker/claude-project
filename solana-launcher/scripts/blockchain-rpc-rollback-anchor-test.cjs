"use strict";
const assert=require("node:assert/strict");
const {mkdtempSync,mkdirSync,copyFileSync,rmSync,existsSync}=require("node:fs");
const {join}=require("node:path");
const {tmpdir}=require("node:os");
const {fork}=require("node:child_process");
const Database=require("better-sqlite3");
const now=Date.UTC(2026,9,20,15);
const binding={eventKey:"chain:synthetic:1",keyId:"key",endpointId:"source",genesisHash:"1".repeat(32)};
if(process.argv[2]==="--child"){
  process.once("message",data=>{
    const {openRpcRollbackAnchor}=require("./blockchain-rpc-rollback-anchor.cjs");
    const anchor=openRpcRollbackAnchor(data.anchor);
    if(data.action==="crash-after-anchor"){
      const advance=anchor.advance;
      anchor.advance=record=>{advance(record);process.exit(23)};
    }
    if(data.action==="crash-after-challenge"){
      const low=require("./blockchain-rpc-challenge-store.cjs"),open=low.openRpcChallengeStore;
      low.openRpcChallengeStore=(...args)=>{
        const store=open(...args),consume=store.consumeChallenge;
        store.consumeChallenge=record=>{consume(record);process.exit(23)};
        return store;
      };
    }
    const {openRpcRecoveryAuthority}=require("./blockchain-rpc-recovery-authority.cjs");
    const authority=openRpcRecoveryAuthority(data.authority,{anchor,clock:()=>now});
    const store=authority.openChallenges();store.consumeChallenge(data.record);
    store.close();authority.close();anchor.close();process.disconnect();
  });
}else{
  const {createRpcRollbackAnchor,openRpcRollbackAnchor,scopeFor}=require("./blockchain-rpc-rollback-anchor.cjs");
  const {createRpcRecoveryAuthority,openRpcRecoveryAuthority}=require("./blockchain-rpc-recovery-authority.cjs");
  function crash(anchor,authority,action,record){
    return new Promise((resolve,reject)=>{
      const p=fork(__filename,["--child"],{stdio:["ignore","ignore","ignore","ipc"]});
      p.on("error",reject);p.on("exit",code=>code===23?resolve():reject(Error("synthetic_anchor_crash_missing")));
      p.send({anchor,authority,action,record});
    });
  }
  async function main(){
    const dir=mkdtempSync(join(tmpdir(),"arch06-anchor-"));
    for(const folder of ["anchor","control","data","snapshots"])mkdirSync(join(dir,folder));
    const anchorFile=join(dir,"anchor","witness.sqlite"),authorityFile=join(dir,"control","generation.sqlite");
    const data=join(dir,"data","challenges.sqlite"),savedData=join(dir,"snapshots","data.sqlite");
    const savedAuthority=join(dir,"snapshots","authority.sqlite");
    const savedAnchor=join(dir,"snapshots","anchor.sqlite");
    let anchor,authority,store,reader;
    const record=c=>({...binding,challenge:c.challenge,now});
    async function backup(file,target){
      const db=new Database(file);try{await db.backup(target)}finally{db.close()}
    }
    function recover(){
      authority=openRpcRecoveryAuthority(authorityFile,{anchor,clock:()=>now,allowAnchorRecovery:true});
      const s=authority.recoveryStatus();
      assert.throws(()=>authority.openChallenges(),/joint_store_rollback/);
      const pending=authority.beginAnchoredRecovery(s.epoch,s.anchor.head);
      authority.finishRecovery(pending.epoch,s.epoch);
      store=authority.openChallenges();
    }
    try{
      assert.throws(()=>openRpcRollbackAnchor(anchorFile),/open/);
      assert.equal(existsSync(anchorFile),false);
      anchor=createRpcRollbackAnchor(anchorFile,{authorityFilename:authorityFile});
      const genesis=anchor.readHead();assert.equal(genesis.sequence,0);
      await backup(anchorFile,savedAnchor);
      assert.throws(()=>anchor.advance({expectedHead:"0".repeat(64),scope:genesis.scope,operation:"consume"}),/compare_failed/);
      assert.deepEqual(anchor.readHead(),genesis,"failed CAS leaves the independent anchor unchanged");
      authority=createRpcRecoveryAuthority(authorityFile,{anchor,challengeFilename:data,clock:()=>now});
      store=authority.createChallenges();
      const advance=anchor.advance,checkpoint=anchor.readHead();
      anchor.advance=()=>({});
      assert.throws(()=>store.issue(binding),/advance_invalid/);
      anchor.advance=advance;
      assert.deepEqual(anchor.readHead(),checkpoint,"malformed adapter result cannot authorize a DB write");
      const old=store.issue(binding);
      await backup(data,savedData);await backup(authorityFile,savedAuthority);
      const before=anchor.readHead();
      const readHead=anchor.readHead;
      anchor.readHead=()=>{throw Error("synthetic unavailable witness")};
      assert.throws(()=>store.consumeChallenge(record(old)),/unavailable witness/);
      anchor.readHead=readHead;
      assert.equal(store.consumeChallenge(record(old)),true);
      assert.equal(anchor.readHead().sequence,before.sequence+1,"consumption anchored within unchanged epoch");
      store.close();store=null;authority.close();authority=null;
      copyFileSync(savedData,data);copyFileSync(savedAuthority,authorityFile);
      assert.throws(()=>openRpcRecoveryAuthority(authorityFile,{anchor,clock:()=>now}),/joint_store_rollback/);
      assert.throws(()=>openRpcRecoveryAuthority(authorityFile,{clock:()=>now}),/independent_rollback_anchor/);
      // Restore both stores, preserve independent witness. Old unused snapshot cannot replay.
      recover();assert.equal(store.consumeChallenge(record(old)),false);
      let nonce=store.issue(binding);
      store.close();store=null;authority.close();authority=null;
      // Anchor commit survives a process crash before either local DB commits.
      await crash(anchorFile,authorityFile,"crash-after-anchor",record(nonce));
      assert.throws(()=>openRpcRecoveryAuthority(authorityFile,{anchor,clock:()=>now}),/joint_store_rollback/);
      recover();assert.equal(store.consumeChallenge(record(nonce)),false);
      nonce=store.issue(binding);
      store.close();store=null;authority.close();authority=null;
      // Challenge consumption committed, authority checkpoint did not: still fail closed.
      await crash(anchorFile,authorityFile,"crash-after-challenge",record(nonce));
      recover();assert.equal(store.consumeChallenge(record(nonce)),false);
      const fresh=store.issue(binding);assert.equal(store.consumeChallenge(record(fresh)),true);
      store.close();store=null;authority.close();authority=null;
      // Anchor is reopened independently; no process-local high-water mark is needed.
      const head=anchor.readHead();anchor.close();anchor=openRpcRollbackAnchor(anchorFile);
      assert.deepEqual(anchor.readHead(),head);
      authority=openRpcRecoveryAuthority(authorityFile,{anchor,clock:()=>now});
      store=authority.openChallenges();assert.equal(store.consumeChallenge(record(fresh)),false);
      reader=new Database(anchorFile);
      assert.throws(()=>reader.exec("DELETE FROM anchor_log"),/retained/);
      assert.throws(()=>reader.exec("UPDATE anchor_log SET sequence=sequence"),/append only/);
      assert.throws(()=>reader.exec("INSERT OR REPLACE INTO anchor_log SELECT * FROM anchor_log LIMIT 1"),/sequence/);
      assert.equal(reader.prepare("SELECT COUNT(*) n FROM anchor_log").get().n,anchor.readHead().sequence+1);
      reader.close();reader=null;
      const wrongFile=join(dir,"anchor","wrong.sqlite"),wrong=createRpcRollbackAnchor(wrongFile,{authorityFilename:authorityFile});
      try{assert.throws(()=>openRpcRecoveryAuthority(authorityFile,{anchor:wrong,clock:()=>now}),/regressed_or_replaced/)}
      finally{wrong.close()}
      const foreign=join(dir,"anchor","foreign.sqlite");reader=new Database(foreign);
      reader.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES('synthetic')");
      assert.throws(()=>openRpcRollbackAnchor(foreign),/dedicated_rollback_anchor/);
      assert.equal(reader.prepare("SELECT value FROM keep").get().value,"synthetic");
      reader.close();reader=null;
      assert.equal(anchor.readHead().scope,scopeFor(authorityFile));
      store.close();store=null;authority.close();authority=null;anchor.close();anchor=null;
      copyFileSync(savedAnchor,anchorFile);anchor=openRpcRollbackAnchor(anchorFile);
      assert.throws(()=>openRpcRecoveryAuthority(authorityFile,{anchor,clock:()=>now}),/regressed_or_replaced/,
        "rolling back only the witness cannot silently repin the authority");
      console.log("[blockchain-rpc-rollback-anchor-test] OK: independent CAS witness detects joint same-epoch rollback, both crash windows, explicit revocation, restart and append-only history");
    }finally{
      if(reader)reader.close();if(store)store.close();if(authority)authority.close();if(anchor)anchor.close();
      rmSync(dir,{recursive:true,force:true});
    }
  }
  main().catch(error=>{console.error(error);process.exitCode=1});
}
