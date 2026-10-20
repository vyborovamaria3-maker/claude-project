"use strict";
const assert=require("node:assert/strict");
const {mkdtempSync,rmSync,copyFileSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {join}=require("node:path");
const {createHash}=require("node:crypto");
const Database=require("better-sqlite3");
const {openRpcChallengeStore,recoverRpcChallengeStore}=require("./blockchain-rpc-challenge-store.cjs");
const binding={eventKey:"chain:synthetic:revision:1",keyId:"key",endpointId:"source",genesisHash:"1".repeat(32)};
const now=Date.UTC(2026,9,20,13),epochA="a".repeat(64),epochB="b".repeat(64),epochC="c".repeat(64);
const options=epoch=>({clock:()=>now,recoveryEpoch:epoch});
async function main(){
  const dir=mkdtempSync(join(tmpdir(),"arch06-recovery-"));
  const file=join(dir,"active.sqlite"),snapshot=join(dir,"snapshot.sqlite"),restored=join(dir,"restored.sqlite");
  let store,reader,stale,recovered;
  try{
    assert.throws(()=>openRpcChallengeStore(file),/independent_recovery_epoch/);
    assert.throws(()=>recoverRpcChallengeStore(join(dir,"missing.sqlite"),{
      ...options(epochB),previousEpoch:epochA}),/open/);
    store=openRpcChallengeStore(file,options(epochA));
    const spent=store.issue(binding),unused=store.issue(binding);
    const record=c=>({...binding,challenge:c.challenge,now});
    reader=new Database(file);await reader.backup(snapshot);reader.close();reader=null;
    assert.equal(store.consumeChallenge(record(spent)),true);
    store.close();store=null;
    // Restore a consistent pre-consumption snapshot into a closed, separate path.
    // The trusted external epoch advances independently and is NOT in this snapshot.
    copyFileSync(snapshot,restored);
    assert.throws(()=>openRpcChallengeStore(restored,options(epochB)),/epoch_mismatch/,
      "new external pin refuses old DB before recovery");
    assert.throws(()=>recoverRpcChallengeStore(restored,{...options(epochB),previousEpoch:epochC}),/compare_failed/);
    assert.throws(()=>recoverRpcChallengeStore(restored,{...options(epochA),previousEpoch:epochA}),/independent_recovery_epoch/);
    stale=openRpcChallengeStore(restored,options(epochA)); // emulate a pre-rotation handle
    recovered=recoverRpcChallengeStore(restored,{...options(epochB),previousEpoch:epochA});
    assert.throws(()=>recoverRpcChallengeStore(restored,{...options(epochA),previousEpoch:epochB}),
      /epoch_reused/,"an earlier row generation cannot be reactivated by caller error");
    assert.equal(stale.consumeChallenge(record(spent)),false,"old live handle fenced after rotation");
    assert.throws(()=>stale.issue(binding),/epoch_mismatch/);
    stale.close();stale=null;
    for(const challenge of [spent,unused])assert.equal(recovered.consumeChallenge(record(challenge)),false,
      "all pre-recovery challenges revoked, even if restored as unused");
    const fresh=recovered.issue(binding);
    assert.equal(recovered.consumeChallenge(record(fresh)),true);
    recovered.close();recovered=null;
    assert.throws(()=>openRpcChallengeStore(restored,options(epochA)),/epoch_mismatch/);
    recovered=openRpcChallengeStore(restored,options(epochB));
    assert.equal(recovered.consumeChallenge(record(spent)),false,"revocation survives restart");
    assert.equal(recovered.consumeChallenge(record(fresh)),false,"fresh consumption survives restart");
    reader=new Database(restored);
    const rows=reader.prepare("SELECT recovery_epoch,consumed_at FROM rpc_challenges").all();
    assert.equal(rows.filter(r=>r.recovery_epoch===epochA&&r.consumed_at===null).length,2,
      "revoked rows retained for audit, never rewritten to consumed fiction");
    reader.close();reader=null;
    recovered.close();recovered=null;
    // A second rollback must require another independent generation transition.
    const again=join(dir,"again.sqlite");copyFileSync(snapshot,again);
    assert.throws(()=>openRpcChallengeStore(again,options(epochB)),/epoch_mismatch/);
    recovered=recoverRpcChallengeStore(again,{...options(epochC),previousEpoch:epochA});
    assert.equal(recovered.consumeChallenge(record(spent)),false);
    recovered.close();recovered=null;
    // Explicit v1 migration preserves audit bytes but revokes every legacy nonce.
    const legacy=join(dir,"legacy.sqlite"),nonce="d".repeat(64);
    reader=new Database(legacy);
    reader.exec(`PRAGMA application_id=1095906883; PRAGMA user_version=1;
      CREATE TABLE rpc_challenges(challenge_hash TEXT PRIMARY KEY,event_key TEXT,key_id TEXT,
      endpoint_id TEXT,genesis_hash TEXT,issued_at INTEGER,expires_at INTEGER,consumed_at INTEGER);`);
    reader.prepare("INSERT INTO rpc_challenges VALUES(?,?,?,?,?,?,?,NULL)").run(
      createHash("sha256").update(nonce).digest("hex"),binding.eventKey,binding.keyId,
      binding.endpointId,binding.genesisHash,now,now+60000);
    assert.throws(()=>openRpcChallengeStore(legacy,options(epochB)),/recovery_required/);
    assert.equal(reader.pragma("user_version",{simple:true}),1,"ordinary open never migrates legacy DB");
    reader.close();reader=null;
    recovered=recoverRpcChallengeStore(legacy,{...options(epochB),previousEpoch:null});
    assert.equal(recovered.consumeChallenge({...binding,challenge:nonce,now}),false);
    const migrated=recovered.issue(binding);
    assert.equal(recovered.consumeChallenge(record(migrated)),true);
    console.log("[blockchain-rpc-challenge-store-recovery-test] OK: temporary snapshot rollback, external generation gate, stale handles, global revocation, restart and legacy migration");
  }finally{
    if(reader)reader.close();if(store)store.close();if(stale)stale.close();if(recovered)recovered.close();
    rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
