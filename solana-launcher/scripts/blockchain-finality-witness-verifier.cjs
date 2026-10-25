"use strict";
// Offline, Ed25519-authenticated OBSERVER report verification. Signatures
// authenticate a configured witness, not the upstream RPC server or consensus.
const {createPublicKey,verify,createHash}=require("node:crypto");
const DOMAIN=Buffer.from("SOLANA-FINALITY-WITNESS-v1\0");
const BASE58=/^[1-9A-HJ-NP-Za-km-z]{20,100}$/;
const HEX=/^[a-f0-9]{64}$/;
const LABEL=/^[A-Za-z0-9_-]{1,64}$/;
const MAX_PAYLOAD=32*1024;
const fail=reason=>({status:"insufficient_evidence",reason});
const exact=(x,keys)=>x&&typeof x==="object"&&!Array.isArray(x)&&
  Object.keys(x).sort().join(",")===keys.slice().sort().join(",");
const sha=v=>createHash("sha256").update(v).digest("hex");
function validSource(s){
  return exact(s,["kind","address","signature","slot","rawRevision","rawSha256","revisionSetHash"]) &&
    ["wallet","token","creator","dex_program"].includes(s.kind)&&
    BASE58.test(s.address)&&BASE58.test(s.signature)&&
    Number.isSafeInteger(s.slot)&&s.slot>0&&
    Number.isSafeInteger(s.rawRevision)&&s.rawRevision>0&&
    HEX.test(s.rawSha256)&&HEX.test(s.revisionSetHash);
}
function validatePins(pins){
  if(!Array.isArray(pins)||pins.length!==2)throw Error("Two explicit out-of-band witness pins required");
  const ids=new Set(),endpoints=new Set(),keys=new Set(),genesis=new Set();
  return pins.map(p=>{
    if(!exact(p,["keyId","endpointId","genesisHash","publicKey"])||
      !LABEL.test(p.keyId)||!LABEL.test(p.endpointId)||
      !BASE58.test(p.genesisHash))throw Error("Invalid out-of-band witness pin");
    let key;
    try{key=createPublicKey(p.publicKey);}catch{throw Error("Invalid pinned public key");}
    if(key.asymmetricKeyType!=="ed25519")throw Error("Pinned Ed25519 key required");
    const der=key.export({type:"spki",format:"der"}).toString("hex");
    if(ids.has(p.keyId)||endpoints.has(p.endpointId)||keys.has(der))
      throw Error("Witness keys, endpoint IDs and identities must differ");
    ids.add(p.keyId);endpoints.add(p.endpointId);keys.add(der);genesis.add(p.genesisHash);
    return {...p,key};
  }).map((p,_,all)=>{
    if(genesis.size!==1)throw Error("Witnesses disagree on pinned genesis");
    return p;
  });
}
function verifyReport(envelope,pin,expected){
  try{return checked(envelope,pin,expected);}catch{return fail("invalid_witness_package");}
}
function checked(envelope,pin,{challenge,source,now}={}){
  if(!exact(envelope,["payload","signature"])||typeof envelope.payload!=="string"||
    Buffer.byteLength(envelope.payload)>MAX_PAYLOAD||
    typeof envelope.signature!=="string"||
    !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))
    return fail("invalid_witness_envelope");
  if(!pin||!LABEL.test(pin.keyId)||!LABEL.test(pin.endpointId)||
    !BASE58.test(pin.genesisHash)||!HEX.test(challenge)||!validSource(source)||
    !Number.isSafeInteger(now)||now<0)return fail("trusted_binding_required");
  const key=pin.key||createPublicKey(pin.publicKey);
  if(key.asymmetricKeyType!=="ed25519")return fail("ed25519_pin_required");
  const signature=Buffer.from(envelope.signature,"base64");
  if(signature.toString("base64")!==envelope.signature||
    !verify(null,Buffer.concat([DOMAIN,Buffer.from(envelope.payload)]),key,signature))
    return fail("witness_signature_invalid");
  const p=JSON.parse(envelope.payload);
  if(!exact(p,["version","keyId","endpointId","genesisHash","challenge","source",
    "startedAt","completedAt","exchanges"])||p.version!==1)
    return fail("unsupported_witness_payload");
  if(p.keyId!==pin.keyId||p.endpointId!==pin.endpointId||p.genesisHash!==pin.genesisHash)
    return fail("witness_pin_mismatch");
  if(p.challenge!==challenge||JSON.stringify(p.source)!==JSON.stringify(source))
    return fail("challenge_or_raw_revision_mismatch");
  if(!Number.isSafeInteger(p.startedAt)||!Number.isSafeInteger(p.completedAt)||
    p.startedAt<0||p.completedAt<p.startedAt||p.completedAt-p.startedAt>30_000||
    p.completedAt>now||now-p.startedAt>300_000)
    return fail("witness_observation_expired_or_clock_invalid");
  if(!Array.isArray(p.exchanges)||p.exchanges.length!==2)
    return fail("bound_genesis_and_signature_exchanges_required");
  const expectedRequests=[
    {method:"getGenesisHash",params:[]},
    {method:"getSignatureStatuses",params:[[source.signature],{searchTransactionHistory:true}]}
  ];
  const seen=new Set();
  for(let i=0;i<2;i++){
    const e=p.exchanges[i];
    if(!exact(e,["request","response"])||
      !exact(e.request,["jsonrpc","id","method","params"])||
      !exact(e.response,["jsonrpc","id","result"]))
      return fail("rpc_exchange_envelope_invalid");
    const req=e.request,res=e.response;
    if(req.jsonrpc!=="2.0"||res.jsonrpc!=="2.0"||
      !LABEL.test(req.id)||seen.has(req.id)||req.id!==res.id||
      req.method!==expectedRequests[i].method||
      JSON.stringify(req.params)!==JSON.stringify(expectedRequests[i].params))
      return fail("rpc_request_not_bound_to_signature");
    seen.add(req.id);
  }
  if(p.exchanges[0].response.result!==pin.genesisHash)
    return fail("genesis_result_mismatch");
  const r=p.exchanges[1].response.result;
  if(!r||!Number.isSafeInteger(r.context?.slot)||
    r.context.slot<source.slot||!Array.isArray(r.value)||r.value.length!==1||!r.value[0])
    return fail("signature_status_missing_or_old");
  const s=r.value[0];
  if(s.slot!==source.slot||s.err!==null||
    s.confirmations!==null||s.confirmationStatus!=="finalized"||
    !exact(s.status,["Ok"])||s.status.Ok!==null)
    return fail("signature_not_reported_finalized_at_raw_slot");
  return {status:"witness_reported_finalized",keyId:pin.keyId,
    endpointId:pin.endpointId,genesisHash:pin.genesisHash,
    source,contextSlot:r.context.slot,observedAt:p.completedAt,
    proofSha256:sha(envelope.payload),
    independentConsensusFinality:false,authoritativePnlEligible:false};
}
module.exports={DOMAIN,MAX_PAYLOAD,validSource,validatePins,verifyReport,sha};
