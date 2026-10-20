"use strict";
// Offline verifier only. No signer, network, key discovery, DB or feature flags.
const {createPublicKey,verify}=require("node:crypto");
const {buildVerificationPlan,verifyOfflineSwapProof}=require("./blockchain-swap-proof-validation.cjs");
const DOMAIN=Buffer.from("ARCH-06-RPC-OBSERVATION-v1\0");
const MAX_BYTES=256*1024;
const fail=reason=>({status:"insufficient_evidence",reason});
const exact=(value,keys)=>value&&typeof value==="object"&&!Array.isArray(value)&&
  Object.keys(value).sort().join(",")===keys.split(",").sort().join(",");
const label=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
const challenge=value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);

/**
 * trust is an OUT-OF-BAND pin, never derived from the signed package:
 * {keyId,publicKey,endpointId,genesisHash}. endpointId is an opaque label, not a URL.
 * expected.challenge is a verifier-issued random 32-byte hex challenge. The caller
 * MUST atomically consume it on acceptance before using a result. This pure check
 * deliberately has no replay store; repeated verification alone is not freshness.
 * now is trusted verifier time in epoch milliseconds, not package-provided time.
 */
function verifyRpcProvenance(event,envelope,trust,expected){
  try{return checked(event,envelope,trust,expected)}
  catch{return fail("invalid_provenance_package")}
}
function checked(event,envelope,trust,expected){
  if(!exact(envelope,"payload,signature")||typeof envelope.payload!=="string"||
     Buffer.byteLength(envelope.payload)>MAX_BYTES||typeof envelope.signature!=="string"||
     !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))return fail("invalid_provenance_envelope");
  if(!trust||!label(trust.keyId)||!label(trust.endpointId)||
     typeof trust.genesisHash!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trust.genesisHash)||
     !expected||!challenge(expected.challenge)||!Number.isSafeInteger(expected.now))
    return fail("trusted_pin_and_challenge_required");
  const key=createPublicKey(trust.publicKey);
  if(key.asymmetricKeyType!=="ed25519")return fail("ed25519_pin_required");
  const signature=Buffer.from(envelope.signature,"base64");
  if(signature.toString("base64")!==envelope.signature||
     !verify(null,Buffer.concat([DOMAIN,Buffer.from(envelope.payload)]),key,signature))
    return fail("collector_signature_invalid");
  const p=JSON.parse(envelope.payload);
  if(!exact(p,"version,keyId,endpointId,genesisHash,challenge,eventKey,startedAt,completedAt,exchanges")||
     p.version!==1)return fail("unsupported_provenance_payload");
  if(p.keyId!==trust.keyId||p.endpointId!==trust.endpointId||p.genesisHash!==trust.genesisHash)
    return fail("collector_or_endpoint_pin_mismatch");
  if(p.challenge!==expected.challenge||p.eventKey!==event.eventKey)
    return fail("challenge_or_revision_mismatch");
  // Fixed conservative bounds: caller cannot loosen freshness using package fields.
  if(!Number.isSafeInteger(p.startedAt)||!Number.isSafeInteger(p.completedAt)||
     p.startedAt<0||p.completedAt<p.startedAt||p.completedAt-p.startedAt>30_000||
     p.completedAt>expected.now||expected.now-p.startedAt>300_000)
    return fail("observation_expired_or_invalid_clock");
  const plan=buildVerificationPlan(event); // binds mint, signature, raw revision/hash
  const plans=[{method:"getGenesisHash",params:[]},plan.signature,plan.mint];
  if(!Array.isArray(p.exchanges)||p.exchanges.length!==3)
    return fail("three_bound_exchanges_required");
  const ids=new Set();
  for(let i=0;i<plans.length;i++){
    const pair=p.exchanges[i];
    if(!exact(pair,"request,response")||!exact(pair.request,"jsonrpc,id,method,params")||
       !exact(pair.response,"jsonrpc,id,result"))return fail("invalid_rpc_exchange");
    const {request:r,response:s}=pair;
    if(r.jsonrpc!=="2.0"||s.jsonrpc!=="2.0"||!label(r.id)||ids.has(r.id)||s.id!==r.id||
       r.method!==plans[i].method||JSON.stringify(r.params)!==JSON.stringify(plans[i].params))
      return fail("rpc_request_response_mismatch");
    ids.add(r.id);
  }
  if(p.exchanges[0].response.result!==trust.genesisHash)return fail("rpc_cluster_mismatch");
  const result=verifyOfflineSwapProof(event,{
    signatureRequest:plan.signature,signatureResponse:p.exchanges[1].response,
    mintRequest:plan.mint,mintResponse:p.exchanges[2].response,
  });
  if(result.status==="insufficient_evidence")return result;
  // Only expose an allowlist. A collector signature authenticates its report,
  // not the remote RPC provider, TLS exchange, cluster consensus or historical state.
  return {
    status:"configured_collector_attested_rpc_observation",
    provenance:"collector_signature_verified",
    endpointId:trust.endpointId,keyId:trust.keyId,genesisHash:trust.genesisHash,
    observedAt:p.completedAt,sourceEventKey:p.eventKey,
    historicalMintState:"unknown",tradeStatus:"not_a_confirmed_trade_tape",
    requiresAtomicChallengeConsumption:true,
    limits:["collector_is_a_trusted_witness_not_rpc_provider_attestation",
      "tls_and_acquisition_not_verified_by_this_offline_module",
      "not_cryptographic_finality_or_historical_mint_proof",
      "not_a_verified_trade_or_pnl"],
  };
}
/** Acceptance adapter: consumeChallenge is a trusted atomic compare-and-consume
 * operation against an independently issued, event-bound challenge record. It
 * MUST reject unknown/expired/already consumed records and return literal true.
 * No in-process fallback: a fresh Set per call would silently permit replay.
 */
async function acceptRpcProvenance(event,envelope,trust,expected,consumeChallenge){
  const result=verifyRpcProvenance(event,envelope,trust,expected);
  if(result.status==="insufficient_evidence")return result;
  if(typeof consumeChallenge!=="function")return fail("atomic_challenge_consumer_required");
  try{
    const accepted=await consumeChallenge({challenge:expected.challenge,
      eventKey:result.sourceEventKey,keyId:result.keyId,endpointId:result.endpointId,
      genesisHash:result.genesisHash,now:expected.now});
    if(accepted!==true)return fail("challenge_unknown_expired_or_consumed");
    return {...result,requiresAtomicChallengeConsumption:false,challengeConsumed:true};
  }catch{return fail("challenge_consumer_unavailable")}
}
module.exports={verifyRpcProvenance,acceptRpcProvenance};
