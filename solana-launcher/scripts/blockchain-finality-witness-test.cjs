"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {generateKeyPairSync,sign}=require("node:crypto");
const Database=require("better-sqlite3");
const {initDb,persistEvents}=require("./blockchain-seed-collector.cjs");
const {normalizeFullTransaction}=require("./blockchain-alchemy-provider.cjs");
const fixture=require("./fixtures/alchemy-saved-swaps.json");
const {DOMAIN,verifyReport,validatePins}=require("./blockchain-finality-witness-verifier.cjs");
const {openWitnessState,issue,accept,quorum}=require("./blockchain-finality-witness-store.cjs");
const {main:cli}=require("./blockchain-finality-witness.cjs");
const genesis="1".repeat(32);
const pairs=[generateKeyPairSync("ed25519"),generateKeyPairSync("ed25519")];
const pins=pairs.map((kp,i)=>({keyId:"witness"+i,endpointId:"external-endpoint-"+i,
  genesisHash:genesis,publicKey:kp.publicKey.export({type:"spki",format:"pem"})}));
const epoch="a".repeat(64);
function createReceipt(challenge,idx,{status="finalized",slot=challenge.source.slot,
  genesisReply=genesis,contextSlot=challenge.source.slot+10,override}={}){
  const source=challenge.source,t=1_700_000_000_000;
  const payload={
    version:1,keyId:pins[idx].keyId,endpointId:pins[idx].endpointId,genesisHash:genesis,
    challenge:challenge.challenge,source,startedAt:t+500,completedAt:t+800,
    exchanges:[
      {request:{jsonrpc:"2.0",id:"genesis-"+idx,method:"getGenesisHash",params:[]},
        response:{jsonrpc:"2.0",id:"genesis-"+idx,result:genesisReply}},
      {request:{jsonrpc:"2.0",id:"signature-"+idx,method:"getSignatureStatuses",
        params:[[source.signature],{searchTransactionHistory:true}]},
      response:{jsonrpc:"2.0",id:"signature-"+idx,result:{context:{slot:contextSlot},
        value:[{slot,confirmations:null,err:null,status:{Ok:null},confirmationStatus:status}]}}}
    ]
  };
  override?.(payload);
  const raw=JSON.stringify(payload);
  const signature=sign(null,Buffer.concat([DOMAIN,Buffer.from(raw)]),pairs[idx].privateKey)
    .toString("base64");
  return {payload:raw,signature};
}
function seed(db,kind,address,tx){
  db.prepare("INSERT OR IGNORE INTO chain_seed_targets(kind,address,backfill_complete,possible_gap,collection_provider,raw_history_seen) VALUES(?,?,1,0,'alchemy',0)").run(kind,address);
  persistEvents(db,kind,address,[tx]);
  db.prepare([
    "INSERT INTO chain_forensic_history_coverage",
    "(kind,address,coverage_status,source_provider,observed_transactions,",
    "backfill_complete,possible_gap,forward_cursor_pending,updated_at)",
    "VALUES(?,?,'provider_exhausted','alchemy',1,1,0,0,?)",
    "ON CONFLICT(kind,address) DO UPDATE SET coverage_status='provider_exhausted',",
    "backfill_complete=1,possible_gap=0,forward_cursor_pending=0,gap_reason=NULL"
  ].join(" ")).run(kind,address,Date.now());
}
function run(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"finality-witness-"));
  const sourcePath=path.join(dir,"collector.db"),statePath=path.join(dir,"witness.db");
  const source=new Database(sourcePath);
  let state;
  try{
    initDb(source);
    const tx=normalizeFullTransaction(fixture[0]),wallet=tx.accountKeys[0];
    seed(source,"wallet",wallet,tx);
    seed(source,"token","mint-target",tx);
    const base={kind:"wallet",address:wallet,signature:tx.signature};
    state=openWitnessState(statePath,{sourcePath,recoveryEpoch:epoch});
    assert.throws(()=>openWitnessState(statePath,{sourcePath,recoveryEpoch:"b".repeat(64)}),
      /epoch mismatch/);
    assert.throws(()=>openWitnessState(sourcePath,{sourcePath,recoveryEpoch:epoch}),
      /must be separate/);
    assert.throws(()=>validatePins([{...pins[0]},{...pins[0],keyId:"other"}]),
      /keys, endpoint IDs/);
    const time=1_700_000_001_000, clock=()=>time;
    const first=issue(source,state,{...base,pins,keyId:pins[0].keyId,clock:()=>time-1000});
    assert.equal(first.finalityVerified,false);
    assert.equal(first.pnlEligible,false);
    assert.equal(first.source.rawRevision,1);
    assert.equal(first.source.rawSha256.length,64);
    const envelope1=createReceipt(first,0);
    assert.equal(verifyReport(envelope1,pins[0],{challenge:first.challenge,
      source:first.source,now:time}).status,"witness_reported_finalized");
    assert.equal(verifyReport(createReceipt(first,0,{status:"confirmed"}),pins[0],
      {challenge:first.challenge,source:first.source,now:time}).status,"insufficient_evidence");
    assert.equal(verifyReport(createReceipt(first,0,{genesisReply:"2".repeat(32)}),pins[0],
      {challenge:first.challenge,source:first.source,now:time}).reason,"genesis_result_mismatch");
    assert.equal(verifyReport(createReceipt(first,0,{slot:tx.slot+1}),pins[0],
      {challenge:first.challenge,source:first.source,now:time}).reason,
      "signature_not_reported_finalized_at_raw_slot");
    const tamper=structuredClone(envelope1);
    tamper.payload=tamper.payload.replace("external-endpoint-0","fake-endpoint-0");
    assert.equal(verifyReport(tamper,pins[0],{challenge:first.challenge,
      source:first.source,now:time}).reason,"witness_signature_invalid");
    const accepted=accept(source,state,{pins,envelope:envelope1,clock});
    assert.equal(accepted.status,"signed_witness_observation_stored");
    assert.equal(accepted.consensusFinalityVerified,false);
    assert.equal(accept(source,state,{pins,envelope:envelope1,clock}).reason,
      "witness_challenge_already_used","Replay must never create another receipt");
    assert.equal(state.prepare("SELECT count(*) n FROM witness_receipts").get().n,1);
    const partial=quorum(source,state,{pins,...base});
    assert.equal(partial.acceptedWitnessCount,1);
    assert.equal(partial.status,"insufficient_independent_witness_reports");
    const second=issue(source,state,{...base,pins,keyId:pins[1].keyId,clock:()=>time-1000});
    const envelope2=createReceipt(second,1);
    assert.equal(accept(source,state,{pins,envelope:envelope2,clock}).status,
      "signed_witness_observation_stored");
    const result=quorum(source,state,{pins,...base});
    assert.equal(result.status,"two_pinned_witnesses_reported_finalized");
    assert.equal(result.acceptedWitnessCount,2);
    assert.equal(result.consensusFinalityVerified,false);
    assert.equal(result.pnlEligible,false);
    assert.equal(new Set(result.witnesses.map(x=>x.keyId)).size,2);
    assert.equal(new Set(result.witnesses.map(x=>x.endpointId)).size,2);
    assert.throws(()=>state.prepare("UPDATE witness_receipts SET proof_sha256='fake'").run(),
      /immutable/);
    assert.throws(()=>state.prepare("DELETE FROM witness_challenges").run(),
      /retained/);
    // Bad receipts never consume the nonce, allowing a correctly signed retry.
    const retry=issue(source,state,{...base,pins,keyId:pins[0].keyId,clock:()=>time-1000});
    const malformed=createReceipt(retry,0,{status:"processed"});
    assert.equal(accept(source,state,{pins,envelope:malformed,clock}).status,"insufficient_evidence");
    assert.equal(state.prepare("SELECT consumed_at FROM witness_challenges WHERE challenge_hash=?").get(
      require("node:crypto").createHash("sha256").update(retry.challenge).digest("hex")).consumed_at,null);
    assert.equal(accept(source,state,{pins,envelope:createReceipt(retry,0),clock}).status,
      "signed_witness_observation_stored");
    // Reports created before issuance cannot be attached to a new nonce,
    // even when a trusted witness signs them.
    const premature=issue(source,state,{...base,pins,keyId:pins[0].keyId,clock:()=>time+100});
    assert.equal(accept(source,state,{pins,envelope:createReceipt(premature,0),
      clock:()=>time+150}).reason,"witness_report_precedes_challenge");
    // Expiration uses trusted import clock, not a signer-controlled timestamp.
    const expired=issue(source,state,{...base,pins,keyId:pins[0].keyId,clock:()=>time-1000});
    assert.equal(accept(source,state,{pins,envelope:createReceipt(expired,0),
      clock:()=>time+60_000}).reason,"witness_challenge_expired");
    // A witness challenge is a one-use revision-bound request, not a generic
    // long-lived signature confirmation.
    const stale=issue(source,state,{...base,pins,keyId:pins[0].keyId,clock:()=>time-1000});
    const staleEnvelope=createReceipt(stale,0);
    const changed=structuredClone(tx);
    changed.raw.meta.fee+=13;
    persistEvents(source,"wallet",wallet,[changed]);
    assert.equal(accept(source,state,{pins,envelope:staleEnvelope,clock}).reason,
      "source_raw_changed_or_not_eligible");
    assert.equal(quorum(source,state,{pins,...base}).status,"insufficient_evidence",
      "Old accepted witnesses cannot survive source RAW revision changes");
    assert.equal(state.prepare("SELECT consumed_at FROM witness_challenges WHERE challenge_hash=?")
      .get(require("node:crypto").createHash("sha256").update(stale.challenge).digest("hex")).consumed_at,null);
    // CLI: strict out-of-band pins, explicit paths, no network.
    state.close();state=null;
    const tamperedPath=path.join(dir,"tampered-witness.db");
    const validState=openWitnessState(tamperedPath,{sourcePath,recoveryEpoch:epoch});
    validState.close();
    const corruptState=new Database(tamperedPath);
    corruptState.exec("DROP TRIGGER witness_receipt_no_update");
    corruptState.close();
    assert.throws(()=>openWitnessState(tamperedPath,{sourcePath,recoveryEpoch:epoch}),
      /Witness journal integrity trigger missing/);
    const config=path.join(dir,"trusted-pins.json");
    fs.writeFileSync(config,JSON.stringify({recoveryEpoch:epoch,witnesses:pins}));
    // Exercise the serialized-pin boundary through the real CLI for the whole
    // workflow, not only a negative quorum that can hide pin validation errors.
    const cliTx=normalizeFullTransaction(fixture[1]),cliWallet=cliTx.accountKeys[0];
    seed(source,"wallet",cliWallet,cliTx);
    const cliBase=["--db",sourcePath,"--state",statePath,"--pins",config];
    const cliTarget=["--kind","wallet","--address",cliWallet,"--signature",cliTx.signature];
    for(let idx=0;idx<2;idx++){
      const request=cli(["issue",...cliBase,...cliTarget,"--key-id",pins[idx].keyId],
        {clock:()=>time-1000});
      const receiptPath=path.join(dir,"cli-receipt-"+idx+".json");
      fs.writeFileSync(receiptPath,JSON.stringify(createReceipt(request,idx)));
      assert.equal(cli(["accept",...cliBase,"--file",receiptPath],{clock}).status,
        "signed_witness_observation_stored");
    }
    const cliQuorum=cli(["quorum",...cliBase,...cliTarget]);
    assert.equal(cliQuorum.status,"two_pinned_witnesses_reported_finalized");
    assert.equal(cliQuorum.acceptedWitnessCount,2);
    const bytes=fs.readFileSync(sourcePath);
    const cliResult=cli(["quorum","--db",sourcePath,"--state",statePath,"--pins",config,
      "--kind","wallet","--address",wallet,"--signature",tx.signature]);
    assert.equal(cliResult.pnlEligible,false);
    assert.deepEqual(fs.readFileSync(sourcePath),bytes,
      "Read-only challenge/quorum tooling cannot mutate source collector");
    console.log("[blockchain-finality-witness] OK: two pinned signatures, atomic one-use challenges, revision fencing, offline quorum, no PnL promotion");
  }finally{
    state?.close();
    source.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
run();
