"use strict";
const assert=require("node:assert/strict");
const {buildTokenSwapRevisionEvent}=require("./blockchain-token-swap-revisions.cjs");
const {
  TOKEN_PROGRAM,TOKEN_2022_PROGRAM,buildVerificationPlan,
  parseMintAccount,verifyOfflineSwapProof,
}=require("./blockchain-swap-proof-validation.cjs");

const wallet="1".repeat(32);
const mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const signature="1".repeat(64);
const slot=320000001;
const tx={
  signature,slot,timestamp:1720000000,type:"SWAP",feePayer:wallet,fee:5000,
  events:{swap:{
    nativeInput:{account:wallet,amount:"1000000000"},
    tokenOutputs:[{userAccount:wallet,mint,
      rawTokenAmount:{tokenAmount:"1000000",decimals:6}}],
  }},
  accountData:[{account:wallet,nativeBalanceChange:-1000005000,
    tokenBalanceChanges:[{userAccount:wallet,mint,
      rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}],
};
const event=buildTokenSwapRevisionEvent({
  kind:"wallet",address:wallet,signature,rawRevision:4,
  payloadHash:"d".repeat(64),observedAt:Date.UTC(2026,9,20),
  transaction:tx,
});
assert.equal(event.payload.swapRevision.status,"supported");

function mintBytes(owner=TOKEN_PROGRAM){
  const b=Buffer.alloc(owner===TOKEN_2022_PROGRAM?166:82);
  b[44]=6;b[45]=1;
  if(owner===TOKEN_2022_PROGRAM)b[165]=1;
  return b;
}
function account(bytes=mintBytes(),owner=TOKEN_PROGRAM){
  return {owner,lamports:1461600,executable:false,space:bytes.length,
    data:[bytes.toString("base64"),"base64"]};
}
function receipts(){
  const plan=buildVerificationPlan(event);
  return {
    signatureRequest:plan.signature,mintRequest:plan.mint,
    signatureResponse:{jsonrpc:"2.0",result:{
      context:{slot:slot+10},value:[{
        slot,confirmations:null,err:null,status:{Ok:null},
        confirmationStatus:"finalized",
      }],
    }},
    mintResponse:{jsonrpc:"2.0",result:{
      context:{slot:slot+11},value:account(),
    }},
  };
}
const plan=buildVerificationPlan(event);
assert.deepEqual(plan.signature,{
  method:"getSignatureStatuses",params:[[signature],{searchTransactionHistory:true}],
});
assert.deepEqual(plan.mint,{
  method:"getAccountInfo",params:[mint,{
    commitment:"finalized",encoding:"base64",minContextSlot:slot,
  }],
});
const valid=verifyOfflineSwapProof(event,receipts());
assert.equal(valid.status,"rpc_reported_finalized_tx_and_current_mint");
assert.equal(valid.mintProgram,"spl-token");
assert.equal(valid.provenance,"unverified_offline_receipts");
assert(valid.limits.includes("rpc_origin_and_cluster_not_authenticated"));
assert.equal(valid.transactionSlot,slot);
assert(valid.limits.includes("current_mint_account_not_mint_state_at_transaction_slot"));
assert(!JSON.stringify(valid).includes("tokenBalanceChanges"));

const checks=[
  ["no_rpc_receipts",r=>null],
  ["rpc_error_envelope",r=>{r.signatureResponse.error={code:-32603,message:"synthetic"};return r}],
  ["rpc_error_envelope",r=>{r.mintResponse.error={code:-32603,message:"synthetic"};return r}],
  ["wrong_signature_request",r=>{r.signatureRequest.params[0][0]="2".repeat(64);return r}],
  ["wrong_mint_request",r=>{r.mintRequest.params[1].commitment="confirmed";return r}],
  ["signature_status_unavailable",r=>{r.signatureResponse.result.value=[null];return r}],
  ["signature_status_unavailable",r=>{r.signatureResponse.result.context.slot=slot-1;return r}],
  ["signature_failed_or_unknown_error",r=>{r.signatureResponse.result.value[0].err={InstructionError:[0,"Custom"]};return r}],
  ["signature_status_fields_disagree",r=>{r.signatureResponse.result.value[0].status={Err:{InstructionError:[0,"Custom"]}};return r}],
  ["signature_status_fields_disagree",r=>{delete r.signatureResponse.result.value[0].status;return r}],
  ["transaction_not_reported_finalized",r=>{r.signatureResponse.result.value[0].confirmationStatus="confirmed";return r}],
  ["transaction_not_reported_finalized",r=>{r.signatureResponse.result.value[0].confirmationStatus=null;return r}],
  ["transaction_slot_mismatch",r=>{r.signatureResponse.result.value[0].slot=slot+1;return r}],
  ["mint_read_context_too_old",r=>{r.mintResponse.result.context.slot=slot-1;return r}],
  ["mint_account_missing",r=>{r.mintResponse.result.value=null;return r}],
  ["mint_wrong_program_owner",r=>{r.mintResponse.result.value.owner="11111111111111111111111111111111";return r}],
  ["mint_account_not_usable",r=>{r.mintResponse.result.value.executable=true;return r}],
  ["mint_data_size_mismatch",r=>{r.mintResponse.result.value.space=81;return r}],
  ["mint_data_not_canonical_base64",r=>{r.mintResponse.result.value.data[0]="@";return r}],
  ["mint_wrong_base_length",r=>{r.mintResponse.result.value=account(Buffer.alloc(165));return r}],
  ["mint_base_layout_invalid",r=>{const b=mintBytes();b[45]=0;r.mintResponse.result.value=account(b);return r}],
  ["mint_base_layout_invalid",r=>{const b=mintBytes();b.writeUInt32LE(2,46);r.mintResponse.result.value=account(b);return r}],
  ["token_2022_not_mint",r=>{const b=mintBytes(TOKEN_2022_PROGRAM);b[165]=2;r.mintResponse.result.value=account(b,TOKEN_2022_PROGRAM);return r}],
  ["token_2022_not_mint",r=>{const b=mintBytes(TOKEN_2022_PROGRAM);b[82]=3;r.mintResponse.result.value=account(b,TOKEN_2022_PROGRAM);return r}],
  ["token_2022_truncated_tlv",r=>{const b=Buffer.concat([mintBytes(TOKEN_2022_PROGRAM),Buffer.from([1])]);r.mintResponse.result.value=account(b,TOKEN_2022_PROGRAM);return r}],
  ["token_2022_malformed_tlv",r=>{const b=Buffer.concat([mintBytes(TOKEN_2022_PROGRAM),Buffer.from([2,0,4,0,42])]);r.mintResponse.result.value=account(b,TOKEN_2022_PROGRAM);return r}],
];
for(const [reason,modify] of checks){
  const result=verifyOfflineSwapProof(event,modify(receipts()));
  assert.equal(result.status,"insufficient_evidence");
  assert.equal(result.reason,reason,"wrong reason for "+reason);
}
const extended=Buffer.concat([mintBytes(TOKEN_2022_PROGRAM),Buffer.from([3,0,2,0,9,8])]);
const t22=receipts();
t22.mintResponse.result.value=account(extended,TOKEN_2022_PROGRAM);
assert.equal(verifyOfflineSwapProof(event,t22).mintProgram,"spl-token-2022");
assert.equal(parseMintAccount(account(mintBytes(TOKEN_2022_PROGRAM),TOKEN_2022_PROGRAM)).status,
  "mint_account_layout_supported");
const nonSwap=structuredClone(event);
nonSwap.payload.swapRevision.status="unsupported";
nonSwap.payload.swapRevision.canonicalTokenId=null;
assert.throws(()=>buildVerificationPlan(nonSwap),/attributable supported/);
const mismatch=structuredClone(event);
mismatch.payload.swapRevision.rawSha256="a".repeat(64);
assert.throws(()=>buildVerificationPlan(mismatch),/Unbound or inconsistent/);
assert(!("timelineEvent" in event.payload));
console.log("[blockchain-swap-proof-validation-test] OK: finalized RPC receipt gate, original mint layout, Token-2022 and fail-closed cases");
