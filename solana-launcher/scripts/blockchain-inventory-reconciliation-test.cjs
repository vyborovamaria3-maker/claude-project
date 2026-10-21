"use strict";
const assert=require("node:assert/strict");
const {normalizeFullTransaction}=require("./blockchain-alchemy-provider.cjs");
const {decodeInventoryMovements}=require("./blockchain-inventory-decoder.cjs");
const {atomic,reconcileInventoryEvidence}=require("./blockchain-inventory-reconciliation.cjs");
const fixture=require("./fixtures/alchemy-saved-swaps.json");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {gzipSync}=require("node:zlib");
const {createHash}=require("node:crypto");
const Database=require("better-sqlite3");
const {main:inventoryReplay}=require("./blockchain-inventory-replay.cjs");
const TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const amt=(amount,decimals=0)=>({amount:String(amount),decimals});
function balance(accountIndex,mint,owner,amount,decimals=0){
  return {accountIndex,mint,owner,uiTokenAmount:amt(amount,decimals)};
}
function tx(signature,{preA="100",postA="70",preB="5",postB="35",
  ownerA="alice",ownerB="bob",mint="mint-1",amount="30",operation="transferChecked",programId=TOKEN_PROGRAM}={}){
  const accountKeys=["tokenA","tokenB"], decodedOperations=[{programId,type:operation,
    info:{source:"tokenA",destination:"tokenB",mint,tokenAmount:{amount,decimals:0}}}];
  const preTokenBalances=[balance(0,mint,ownerA,preA),balance(1,mint,ownerB,preB)];
  const postTokenBalances=[balance(0,mint,ownerA,postA),balance(1,mint,ownerB,postB)];
  return {signature,slot:5,timestamp:17,transactionError:null,accountKeys,decodedOperations,
    tokenBalanceDeltas:[],preTokenBalances,postTokenBalances};
}
function run(){
  assert.equal(atomic("90071992547409931234567890").toString(),"90071992547409931234567890");
  assert.equal(atomic(9007199254740993),null);
  assert.equal(atomic("1.5"),null);
  const good=reconcileInventoryEvidence(tx("ok"));
  assert.equal(good.status,"OBSERVED_BALANCES_MATCH_MOVEMENTS");
  assert.equal(good.counts.MATCH,2);
  assert.deepEqual(good.accountRows.map(r=>[r.account,r.expectedDeltaAtomic,r.decodedDeltaAtomic]),
    [["tokenA","-30","-30"],["tokenB","30","30"]]);
  assert.equal(good.financialLedgerEligible,false);
  assert.equal(good.authority,"diagnostic_only");
  assert.equal(good.fullHistoryComplete,false);

  const large=reconcileInventoryEvidence(tx("large",{
    preA:"90071992547409931234567890",postA:"90071992547409931234567859",
    preB:"5",postB:"36",amount:"31"}));
  assert.equal(large.status,"OBSERVED_BALANCES_MATCH_MOVEMENTS");
  assert.equal(large.accountRows[0].expectedDeltaAtomic,"-31");

  const missingOp=tx("missing");missingOp.decodedOperations=[];
  assert.equal(reconcileInventoryEvidence(missingOp).status,"MISMATCH",
    "Raw token balance changes without parsed transfer evidence must not match");
  const partial=tx("partial");partial.postTokenBalances=partial.postTokenBalances.slice(0,1);
  assert.equal(reconcileInventoryEvidence(partial).status,"PARTIAL",
    "One-sided token-account metadata must not mean zero balance");
  const ownerConflict=tx("owner-conflict");
  ownerConflict.postTokenBalances[0].owner="charlie";
  const conflicted=reconcileInventoryEvidence(ownerConflict);
  assert.equal(conflicted.status,"CONFLICT");
  assert.equal(conflicted.accountRows[0].reason,"owner_changed_across_balance_snapshots");
  assert.equal(decodeInventoryMovements(ownerConflict)[0].owner,null,
    "Conflicting pre/post owner must not be silently overwritten");
  assert.equal(decodeInventoryMovements(ownerConflict)[0].attributionStatus,"owner_conflict");
  const undecodable=tx("float",{amount:"30"});
  undecodable.decodedOperations[0].info.tokenAmount.amount=0.3;
  assert.equal(decodeInventoryMovements(undecodable)[0].amountRaw,null);


  const mintConflict=tx("mint-conflict");
  mintConflict.postTokenBalances[1].mint="mint-2";
  assert.equal(reconcileInventoryEvidence(mintConflict).status,"CONFLICT");

  const unsafe=tx("unsafe");
  unsafe.decodedOperations[0].info.tokenAmount.amount=9007199254740993;
  const unsafeResult=reconcileInventoryEvidence(unsafe);
  assert.equal(unsafeResult.status,"MISMATCH");
  assert.ok(unsafeResult.accountRows.every(r=>r.status==="MISMATCH"),
    "The unparseable instruction cannot become a fabricated exact movement");

  const t22=tx("token2022",{postA:"0",postB:"100",preA:"100",preB:"0",amount:"100",programId:TOKEN_2022});
  t22.postTokenBalances[1].uiTokenAmount.amount="95";
  assert.equal(reconcileInventoryEvidence(t22).status,"MISMATCH",
    "Transfer-fee withholding must not be silently assigned to user inventory");

  const failed=tx("failed");failed.transactionError={Custom:1};
  assert.equal(reconcileInventoryEvidence(failed).status,"FAILED_EXECUTION");
  const unknown=tx("unknown");delete unknown.transactionError;
  assert.equal(reconcileInventoryEvidence(unknown).status,"UNKNOWN_EXECUTION");
  const none=tx("empty");none.preTokenBalances=[];none.postTokenBalances=[];none.decodedOperations=[];
  assert.equal(reconcileInventoryEvidence(none).status,"NO_TOKEN_EVIDENCE");

  // The 10 saved real Alchemy receipts are replayed without any RPC calls.
  // Reconciliation is deliberately non-authoritative; ambiguous token-2022,
  // account create/close, and unparsed mutations must remain PARTIAL/MISMATCH.
  const real=fixture.map(normalizeFullTransaction);
  assert.equal(real.length,10);
  for(const item of real){
    assert.ok(item?.raw?.meta && item?.transactionError===null);
    const result=reconcileInventoryEvidence(item);
    assert.equal(result.signature,item.signature);
    assert.equal(result.authority,"diagnostic_only");
    assert.equal(result.financialLedgerEligible,false);
    assert.equal(result.fullHistoryComplete,false);
    assert.ok(["OBSERVED_BALANCES_MATCH_MOVEMENTS","PARTIAL","MISMATCH","CONFLICT","NO_TOKEN_EVIDENCE"].includes(result.status),
      "Unexpected result for real signature "+item.signature+": "+result.status);
  }
  // Bounded offline CLI audit: one valid saved RAW and one hash mismatch.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"inventory-replay-"));
  const filename=path.join(dir,"sample.db"), db=new Database(filename);
  try{
    db.exec("CREATE TABLE chain_seed_events(kind TEXT,address TEXT,signature TEXT,slot INTEGER,block_time INTEGER,payload_hash TEXT,payload_gzip BLOB,payload_bytes INTEGER)");
    const insert=db.prepare("INSERT INTO chain_seed_events VALUES(?,?,?,?,?,?,?,?)");
    const replayTx=normalizeFullTransaction(fixture[0]);
    const payload=Buffer.from(JSON.stringify(replayTx));
    const hash=createHash("sha256").update(payload).digest("hex");
    insert.run("token","mint",replayTx.signature,replayTx.slot,replayTx.timestamp,hash,
      gzipSync(payload),payload.length);
    insert.run("wallet","wallet",replayTx.signature,replayTx.slot,replayTx.timestamp,
      "0".repeat(64),gzipSync(payload),payload.length);
    db.close();
    const before=fs.readFileSync(filename);
    const result=inventoryReplay(["--db",filename,"--limit","2"]);
    assert.equal(result.sampledObservations,2);
    assert.equal(result.uniqueSampleSignatures,1,"Duplicate targets are not unique transactions");
    assert.equal(result.rawInvalid,1);
    assert.equal(result.authority,"diagnostic_only");
    assert.equal(result.financialLedgerEligible,false);
    assert.equal(Object.values(result.statuses).reduce((a,b)=>a+b,0),1);
    assert.deepEqual(fs.readFileSync(filename),before,"Read-only replay never mutates the SQLite file");
    assert.throws(()=>inventoryReplay(["--db",filename,"--limit","1001"]));
  } finally {if(db.open)db.close();fs.rmSync(dir,{recursive:true,force:true});}
  console.log("[blockchain-inventory-reconciliation] OK: exact atomic units, two-legged transfer, unknown owner, missing balances, conflicts, Token-2022 withholding, failed tx, 10 real fixtures");
}
run();
