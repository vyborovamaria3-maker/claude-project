"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {gzipSync}=require("node:zlib");
const {createHash}=require("node:crypto");
const Database=require("better-sqlite3");
const {normalizeFullTransaction}=require("./blockchain-alchemy-provider.cjs");
const {inspectLifecycle,WSOL,TOKEN_2022}=require("./blockchain-inventory-lifecycle.cjs");
const {main:historyMain,project}=require("./blockchain-inventory-history.cjs");
const fixture=require("./fixtures/alchemy-saved-swaps.json");
const TOKEN="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
function bal(owner,mint,amount){
  return {accountIndex:0,owner,mint,uiTokenAmount:{amount:String(amount),decimals:9}};
}
function tx(sig,slot=10,{mint="mintA",owner="walletA",preOwner=owner,postOwner=owner,pre="25",post="25",ops=[],failed=false}={}){
  return {signature:sig,slot,transactionError:failed?{custom:1}:null,
    accountKeys:["tokenA","payer"],preTokenBalances:preOwner?[bal(preOwner,mint,pre)]:[],
    postTokenBalances:postOwner?[bal(postOwner,mint,post)]:[],
    preBalances:[2039280,100000],postBalances:[2039280,95000],
    decodedOperations:ops,raw:{meta:{err:failed?{custom:1}:null}}};
}
function op(type,info={},programId=TOKEN){
  return {programId,type,info};
}
function insertSaved(db,kind,address,event,{corruptHash=false,mutatePayload}={}){
  const txObj=mutatePayload?mutatePayload(structuredClone(event)):event;
  const bytes=Buffer.from(JSON.stringify(txObj));
  const hash=createHash("sha256").update(bytes).digest("hex");
  db.prepare("INSERT INTO chain_seed_events VALUES(?,?,?,?,?,?,?,?,?)").run(
    kind,address,event.signature,1,event.slot,event.timestamp,corruptHash?"0".repeat(64):hash,
    gzipSync(bytes),bytes.length);
}
function rawEvent(sig,slot,owner,mint="mintA"){
  const raw={slot,blockTime:1_700_000_000+slot,meta:{
    err:null,fee:5000,preBalances:[2039280,100000],postBalances:[2039280,95000],
    preTokenBalances:[bal(owner,mint,"25")],postTokenBalances:[bal(owner,mint,"25")],
    innerInstructions:[]},
    transaction:{signatures:[sig],message:{accountKeys:[
      {pubkey:"tokenA",signer:false},{pubkey:"payer",signer:true}],instructions:[]}}
  };
  return normalizeFullTransaction(raw);
}
function unit(){
  const clear=inspectLifecycle(tx("same"));
  assert.equal(clear.ownerObservations.length,1);
  assert.equal(clear.ownerObservations[0].side,"BOTH");
  assert.equal(clear.ownerObservations[0].continuityProven,false);
  assert.equal(clear.financialLedgerEligible,false);
  const changed=inspectLifecycle(tx("changed",10,{preOwner:"walletA",postOwner:"walletB"}));
  assert.equal(changed.ownerObservations.length,2);
  assert.ok(changed.issues.some(x=>x.startsWith("SAME_TRANSACTION_OWNER_CHANGE:")));
  const init=inspectLifecycle(tx("init",10,{preOwner:null,pre:"0",
    ops:[op("initializeAccount3",{account:"tokenA",mint:"mintA",owner:"walletA"})]}));
  assert.equal(init.actions[0].eventType,"ACCOUNT_INITIALIZE");
  assert.equal(init.actions[0].status,"POST_BALANCE_CORROBORATED");
  const close=tx("close",10,{postOwner:null,pre:"0",ops:[
    op("closeAccount",{account:"tokenA",destination:"walletA"})]});
  close.postBalances[0]=0;
  const closed=inspectLifecycle(close);
  assert.equal(closed.actions[0].status,"EFFECT_CORROBORATED");
  assert.equal(closed.actions[0].rentRefundNotFee,true);
  assert.equal(closed.actions[0].eventType,"ACCOUNT_CLOSE");
  const badClose=tx("badClose",10,{pre:"25",postOwner:null,ops:[
    op("closeAccount",{account:"tokenA",destination:"walletA"})]});
  assert.equal(inspectLifecycle(badClose).actions[0].status,"INSTRUCTION_ONLY");
  const sync=inspectLifecycle(tx("sync",10,{mint:WSOL,ops:[
    op("syncNative",{account:"tokenA"})]}));
  assert.equal(sync.actions[0].status,"WSOL_OPERATION_OBSERVED");
  assert.equal(sync.actions[0].tradeClassification,"NOT_A_TRADE");
  const wrongSync=inspectLifecycle(tx("nonWsolSync",10,{ops:[
    op("syncNative",{account:"tokenA"})]}));
  assert.equal(wrongSync.actions[0].status,"INSTRUCTION_ONLY");
  assert.ok(wrongSync.issues.some(x=>x.startsWith("SYNC_NATIVE_NON_WSOL:")));
  const t22=inspectLifecycle(tx("t22",10,{ops:[
    op("transferCheckedWithFee",{source:"tokenA",destination:"tokenB",fee:"3"},TOKEN_2022)]}));
  assert.equal(t22.actions[0].eventType,"TOKEN2022_FEE_MECHANISM");
  assert.equal(t22.actions[0].status,"UNVALUED_EVIDENCE");
  assert.equal(t22.actions[0].tradeClassification,"NOT_AUTOMATIC_TRADE_OR_FEE");
  assert.ok(t22.issues.some(x=>x.startsWith("TOKEN2022_WITHHELD_FEE_NOT_RECONCILED:")));
  const fail=inspectLifecycle(tx("fail",10,{failed:true,ops:[
    op("closeAccount",{account:"tokenA"})]}));
  assert.equal(fail.ownerObservations.length,0);
  assert.equal(fail.actions.length,0);
  assert.deepEqual(fail.issues,["EXECUTION_FAILED"]);
  const unknown=tx("unknown");delete unknown.transactionError;
  assert.deepEqual(inspectLifecycle(unknown).issues,["EXECUTION_UNKNOWN"]);
  const wrongMint=tx("mintClash");wrongMint.postTokenBalances[0].mint="mintB";
  const clash=inspectLifecycle(wrongMint);
  assert.equal(clash.ownerObservations.length,0);
  assert.ok(clash.issues.some(x=>x.startsWith("ACCOUNT_MINT_CONFLICT:")));
  // Real saved Alchemy transactions: no artificial authoritative owner spans.
  assert.equal(fixture.length,10);
  for(const f of fixture){
    const t=normalizeFullTransaction(f),result=inspectLifecycle(t);
    assert.equal(result.authority,"diagnostic_only");
    assert.equal(result.financialLedgerEligible,false);
    assert.equal(result.historyContinuityProven,false);
  }
}
function integration(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"inventory-history-"));
  const sourcePath=path.join(dir,"source.db"),outPath=path.join(dir,"evidence.db");
  const source=new Database(sourcePath);
  try{
    source.exec("CREATE TABLE chain_seed_events(kind TEXT,address TEXT,signature TEXT,raw_revision INTEGER,slot INTEGER,block_time INTEGER,payload_hash TEXT,payload_gzip BLOB,payload_bytes INTEGER)");
    // Same raw observed through wallet and mint must not make two ownership facts.
    const a=rawEvent("owner-a",10,"walletA");
    insertSaved(source,"wallet","walletA",a);
    insertSaved(source,"token","mintA",a);
    const a2=rawEvent("owner-a2",20,"walletA");
    insertSaved(source,"wallet","walletA",a2);
    const b=rawEvent("owner-b",30,"walletB");
    insertSaved(source,"wallet","walletB",b);
    // Contradictory RAW payloads under the same signature remain excluded.
    const c=rawEvent("divergent",40,"walletA");
    insertSaved(source,"wallet","walletA",c);
    insertSaved(source,"token","mintA",c,{mutatePayload:t=>{
      t.raw.meta.fee=6000;return t;}});
    // A single corrupt copy with valid counterpart blocks that signature.
    const d=rawEvent("corrupt",50,"walletA");
    insertSaved(source,"wallet","walletA",d);
    insertSaved(source,"token","mintA",d,{corruptHash:true});
    source.close();
    const bytes=fs.readFileSync(sourcePath);
    const report=historyMain(["--db",sourcePath,"--out",outPath,"--limit","100"]);
    assert.equal(report.sourceObservationsSampled,8);
    assert.equal(report.uniqueSignatures,5);
    assert.equal(report.signaturesAccepted,3);
    assert.equal(report.duplicateTargets,1);
    assert.equal(report.rejectedSignatures,2);
    assert.equal(report.financialLedgerEligible,false);
    assert.equal(report.ownerTransitionWarnings,1);
    assert.equal(report.ownerObservedSpans,2);
    const projected=new Database(outPath,{readonly:true});
    try{
      assert.equal(projected.prepare("SELECT count(*) n FROM inventory_owner_observations").get().n,3);
      assert.equal(projected.prepare("SELECT count(*) n FROM inventory_rejected_signatures").get().n,2);
      const span=projected.prepare(
        "SELECT first_observed_slot,last_observed_slot,distinct_observed_signatures,continuity_proven,status FROM inventory_owner_observed_spans WHERE observed_owner='walletA'"
      ).get();
      assert.deepEqual(span,{first_observed_slot:10,last_observed_slot:20,
        distinct_observed_signatures:2,continuity_proven:0,status:"ENDPOINTS_ONLY"});
      assert.equal(projected.prepare("SELECT count(*) n FROM inventory_history_issues WHERE reason='OWNER_OR_MINT_CHANGED_BETWEEN_OBSERVED_ENDPOINTS_UNPROVEN'").get().n,1);
    }finally{projected.close();}
    assert.deepEqual(fs.readFileSync(sourcePath),bytes,"Read-only history must not edit source bytes");
    assert.throws(()=>historyMain(["--db",sourcePath,"--out",outPath]),/must not exist/);
    assert.throws(()=>historyMain(["--db",sourcePath,"--out",path.join(dir,"bad.db"),"--limit","1001"]),/Invalid limit/);
    // Direct project uses the same deterministic API as CLI.
    const db=new Database(sourcePath,{readonly:true}),small=new Database(":memory:");
    try{
      const limited=project(db,small,{limit:1});
      assert.equal(limited.sampleTruncated,true);
      assert.equal(limited.financialLedgerEligible,false);
    }finally{db.close();small.close();}
  }finally{
    if(source.open)source.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
unit();integration();
console.log("[blockchain-inventory-lifecycle] OK: owner endpoints, close/init, WSOL and Token-2022 markers, divergent RAW exclusion, offline read-only projection");
