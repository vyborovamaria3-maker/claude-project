"use strict";
const assert=require("node:assert/strict");
const {generateKeyPairSync,sign,randomBytes}=require("node:crypto");
const {buildTokenSwapRevisionEvent}=require("./blockchain-token-swap-revisions.cjs");
const {buildVerificationPlan,TOKEN_PROGRAM}=require("./blockchain-swap-proof-validation.cjs");
const {verifyRpcProvenance,acceptRpcProvenance}=require("./blockchain-rpc-provenance.cjs");
// Ephemeral synthetic test keys only; never persisted or logged.
const keys=generateKeyPairSync("ed25519");
const trust={keyId:"synthetic-key",endpointId:"synthetic-endpoint",
  publicKey:keys.publicKey.export({type:"spki",format:"pem"}),genesisHash:"1".repeat(32)};
const now=Date.UTC(2026,9,20,10);
const expected={now,challenge:randomBytes(32).toString("hex")};
const wallet="1".repeat(32),mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const signature="1".repeat(64),slot=320000001;
const event=buildTokenSwapRevisionEvent({kind:"wallet",address:wallet,signature,
  rawRevision:1,payloadHash:"a".repeat(64),observedAt:now-1000,
  transaction:{signature,slot,timestamp:1720000000,type:"SWAP",feePayer:wallet,fee:5000,
    events:{swap:{nativeInput:{account:wallet,amount:"1000000000"},
      tokenOutputs:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}},
    accountData:[{account:wallet,nativeBalanceChange:-1000005000,
      tokenBalanceChanges:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}]},
});
assert(event);
const plan=buildVerificationPlan(event);
function payload(){
  const bytes=Buffer.alloc(82);bytes[44]=6;bytes[45]=1;
  const requests=[{method:"getGenesisHash",params:[]},plan.signature,plan.mint];
  const results=[trust.genesisHash,
    {context:{slot:slot+10},value:[{slot,confirmations:null,err:null,status:{Ok:null},confirmationStatus:"finalized"}]},
    {context:{slot:slot+11},value:{owner:TOKEN_PROGRAM,lamports:1461600,executable:false,
      space:82,data:[bytes.toString("base64"),"base64"]}}];
  return {version:1,keyId:trust.keyId,endpointId:trust.endpointId,genesisHash:trust.genesisHash,
    challenge:expected.challenge,eventKey:event.eventKey,startedAt:now-2000,completedAt:now-1000,
    exchanges:requests.map((r,i)=>({request:{jsonrpc:"2.0",id:"test-"+i,...r},
      response:{jsonrpc:"2.0",id:"test-"+i,result:results[i]}}))};
}
function envelope(p=payload(),privateKey=keys.privateKey){
  const text=JSON.stringify(p);
  return {payload:text,signature:sign(null,Buffer.concat([
    Buffer.from("ARCH-06-RPC-OBSERVATION-v1\0"),Buffer.from(text)]),privateKey).toString("base64")};
}
const check=(e=envelope(),t=trust,x=expected)=>verifyRpcProvenance(event,e,t,x);
const valid=check();
assert.equal(valid.status,"configured_collector_attested_rpc_observation");
assert.equal(valid.historicalMintState,"unknown");
assert.equal(valid.tradeStatus,"not_a_confirmed_trade_tape");
assert.equal(valid.requiresAtomicChallengeConsumption,true);
assert(!JSON.stringify(valid).includes("publicKey"));
assert(!JSON.stringify(valid).includes("tokenAmount"));
assert(!JSON.stringify(valid).includes("rpc_reported_finalized"));
const cases=[
  ["collector_or_endpoint_pin_mismatch",p=>{p.keyId="self-selected"}],
  ["collector_or_endpoint_pin_mismatch",p=>{p.endpointId="other-endpoint"}],
  ["collector_or_endpoint_pin_mismatch",p=>{p.genesisHash="2".repeat(32)}],
  ["challenge_or_revision_mismatch",p=>{p.challenge="0".repeat(64)}],
  ["challenge_or_revision_mismatch",p=>{p.eventKey+="changed"}],
  ["observation_expired_or_invalid_clock",p=>{p.startedAt=now-300001;p.completedAt=p.startedAt+1}],
  ["observation_expired_or_invalid_clock",p=>{p.completedAt=now+1}],
  ["observation_expired_or_invalid_clock",p=>{p.completedAt=p.startedAt-1}],
  ["observation_expired_or_invalid_clock",p=>{p.startedAt=now-31001;p.completedAt=now}],
  ["observation_expired_or_invalid_clock",p=>{p.startedAt="yesterday"}],
  ["unsupported_provenance_payload",p=>{p.version=2}],
  ["unsupported_provenance_payload",p=>{p.publicKey=trust.publicKey}],
  ["three_bound_exchanges_required",p=>{p.exchanges.pop()}],
  ["rpc_cluster_mismatch",p=>{p.exchanges[0].response.result="2".repeat(32)}],
  ["rpc_request_response_mismatch",p=>{p.exchanges[1].response.id="wrong"}],
  ["rpc_request_response_mismatch",p=>{p.exchanges[1].request.params[0][0]="2".repeat(64)}],
  ["rpc_request_response_mismatch",p=>{p.exchanges[2].request.params[0]="1".repeat(32)}],
  ["rpc_request_response_mismatch",p=>{p.exchanges[2].request.params[1].commitment="confirmed"}],
  ["rpc_request_response_mismatch",p=>{p.exchanges[1].request.jsonrpc="1.0"}],
  ["rpc_request_response_mismatch",p=>{p.exchanges[2].request.id=p.exchanges[1].request.id}],
  ["invalid_rpc_exchange",p=>{p.exchanges[1].response.error={code:-32603}}],
  ["signature_status_fields_disagree",p=>{p.exchanges[1].response.result.value[0].status={Err:"synthetic"}}],
  ["transaction_not_reported_finalized",p=>{p.exchanges[1].response.result.value[0].confirmationStatus="confirmed"}],
  ["mint_wrong_program_owner",p=>{p.exchanges[2].response.result.value.owner=wallet}],
];
for(const [reason,change] of cases){
  const p=structuredClone(payload());change(p);
  assert.deepEqual(check(envelope(p)),{status:"insufficient_evidence",reason},reason);
}
const tampered=envelope();tampered.payload=tampered.payload.replace("synthetic-endpoint","tampered-endpoint");
assert.equal(check(tampered).reason,"collector_signature_invalid");
assert.equal(check(envelope(payload(),generateKeyPairSync("ed25519").privateKey)).reason,"collector_signature_invalid");
assert.equal(check(envelope(),{...trust,publicKey:"invalid"}).status,"insufficient_evidence");
assert.equal(check(envelope(),trust,{...expected,challenge:""}).reason,"trusted_pin_and_challenge_required");
assert.equal(check(envelope(),trust,{...expected,challenge:randomBytes(32).toString("hex")}).reason,"challenge_or_revision_mismatch");
assert.equal(check({...envelope(),payload:"x".repeat(256*1024+1)}).reason,"invalid_provenance_envelope");
assert.equal(check({...envelope(),signature:"not-base64"}).status,"insufficient_evidence");
assert.equal(check(null).status,"insufficient_evidence");
assert.equal(check(envelope(),null).status,"insufficient_evidence");
const ec=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
assert.equal(check(envelope(),{...trust,publicKey:ec.publicKey.export({type:"spki",format:"pem"})}).reason,"ed25519_pin_required");
const wrongDomain=envelope();
wrongDomain.signature=sign(null,Buffer.from(wrongDomain.payload),keys.privateKey).toString("base64");
assert.equal(check(wrongDomain).reason,"collector_signature_invalid");
const changedRevision=structuredClone(event);
changedRevision.payload.swapRevision.rawSha256="b".repeat(64);
assert.equal(verifyRpcProvenance(changedRevision,envelope(),trust,expected).status,"insufficient_evidence");
// Plain offline receipts cannot become a signed package; no implicit trust fallback.
assert.equal(check({signatureResponse:payload().exchanges[1].response}).status,"insufficient_evidence");
async function acceptanceTests(){
  const e=envelope();
  assert.equal((await acceptRpcProvenance(event,e,trust,expected)).reason,"atomic_challenge_consumer_required");
  assert.equal((await acceptRpcProvenance(event,e,trust,expected,async()=>{throw Error("synthetic")})).reason,
    "challenge_consumer_unavailable");
  assert.equal((await acceptRpcProvenance(event,e,trust,expected,async()=>"true")).status,"insufficient_evidence");
  const issued=new Set([expected.challenge]);
  let calls=0;
  const consume=async record=>{
    calls++;
    assert.deepEqual(record,{challenge:expected.challenge,eventKey:event.eventKey,
      keyId:trust.keyId,endpointId:trust.endpointId,genesisHash:trust.genesisHash,now});
    // Atomic in this single-process synthetic fixture; production needs a durable CAS.
    return issued.delete(record.challenge);
  };
  assert.equal((await acceptRpcProvenance(event,tampered,trust,expected,consume)).status,"insufficient_evidence");
  assert.equal(calls,0,"invalid signature cannot consume a challenge");
  const concurrent=await Promise.all([1,2].map(()=>acceptRpcProvenance(event,e,trust,expected,consume)));
  assert.equal(concurrent.filter(r=>r.challengeConsumed===true).length,1);
  assert.equal(concurrent.filter(r=>r.reason==="challenge_unknown_expired_or_consumed").length,1);
  console.log("[blockchain-rpc-provenance-test] OK: signed witness, pins, cluster, clocks, tampering, atomic replay refusal and no confidence promotion");
}
acceptanceTests().catch(error=>{console.error(error);process.exitCode=1});
