"use strict";
const assert=require("node:assert/strict");
const {normalizeFullTransaction}=require("./blockchain-alchemy-provider.cjs");
const {decodeInventoryMovements}=require("./blockchain-inventory-decoder.cjs");
const {atomic,reconcileInventoryEvidence}=require("./blockchain-inventory-reconciliation.cjs");
const fixture=require("./fixtures/alchemy-saved-swaps.json");
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

  const mintConflict=tx("mint-conflict");
  mintConflict.postTokenBalances[1].mint="mint-2";
  assert.equal(reconcileInventoryEvidence(mintConflict).status,"CONFLICT");

  const unsafe=tx("unsafe");
  unsafe.decodedOperations[0].info.tokenAmount.amount=9007199254740993;
  const unsafeResult=reconcileInventoryEvidence(unsafe);
  assert.equal(unsafeResult.status,"PARTIAL");
  assert.equal(unsafeResult.accountRows.every(r=>r.status==="MATCH"),true,
    "The unparseable instruction is not allowed to contribute numeric movement");

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
  console.log("[blockchain-inventory-reconciliation] OK: exact atomic units, two-legged transfer, unknown owner, missing balances, conflicts, Token-2022 withholding, failed tx, 10 real fixtures");
}
run();
