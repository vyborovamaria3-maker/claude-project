"use strict";
// Offline two-witness acceptance into a DEDICATED SQLite. Never modifies the
// collector, trade cache, inventory or PnL and never asserts consensus finality.
const fs=require("node:fs"),path=require("node:path");
const {randomBytes}=require("node:crypto");
const Database=require("better-sqlite3");
const {aggregate}=require("./blockchain-history-finality-audit.cjs");
const {validatePins,verifyReport,sha,validSource}=require("./blockchain-finality-witness-verifier.cjs");
const APP_ID=0x46573151,SCHEMA_VERSION=1,HEX=/^[a-f0-9]{64}$/;
const fail=reason=>({status:"insufficient_evidence",reason,
  consensusFinalityVerified:false,pnlEligible:false});
const nowValue=clock=>{
  const n=clock();
  if(!Number.isSafeInteger(n)||n<0)throw Error("Trusted clock invalid");
  return n;
};
function sameFile(a,b){
  const aa=path.resolve(a),bb=path.resolve(b);
  if(aa===bb)return true;
  if(!fs.existsSync(aa)||!fs.existsSync(bb))return false;
  const aStat=fs.statSync(aa),bStat=fs.statSync(bb);
  return aStat.dev===bStat.dev&&aStat.ino===bStat.ino||
    fs.realpathSync(aa)===fs.realpathSync(bb);
}
function openWitnessState(filename,{sourcePath,recoveryEpoch}={}){
  if(typeof filename!=="string"||!path.isAbsolute(filename)||
    typeof sourcePath!=="string"||!path.isAbsolute(sourcePath)||
    !HEX.test(recoveryEpoch))throw Error("Explicit absolute source/state and independent epoch required");
  if(!fs.existsSync(sourcePath)||sameFile(filename,sourcePath))
    throw Error("Witness state must be separate from existing source");
  const fresh=!fs.existsSync(filename);
  if(fresh)fs.closeSync(fs.openSync(filename,"wx",0o600));
  const db=new Database(filename,{fileMustExist:true,timeout:1500});
  try{
    if(fresh){
      db.transaction(()=>{
        if(db.pragma("application_id",{simple:true})!==0||
          db.prepare("SELECT count(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n)
          throw Error("New witness state not empty");
        db.exec([
          "CREATE TABLE witness_config(id INTEGER PRIMARY KEY CHECK(id=1),recovery_epoch TEXT NOT NULL);",
          "CREATE TABLE witness_challenges(",
          "challenge_hash TEXT PRIMARY KEY,source_json TEXT NOT NULL,source_hash TEXT NOT NULL,",
          "key_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,genesis_hash TEXT NOT NULL,",
          "issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER,",
          "CHECK(expires_at>issued_at));",
          "CREATE TABLE witness_receipts(",
          "id INTEGER PRIMARY KEY AUTOINCREMENT,challenge_hash TEXT NOT NULL UNIQUE,",
          "source_hash TEXT NOT NULL,key_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,",
          "signature TEXT NOT NULL,raw_revision INTEGER NOT NULL,raw_sha256 TEXT NOT NULL,",
          "context_slot INTEGER NOT NULL,observed_at INTEGER NOT NULL,accepted_at INTEGER NOT NULL,",
          "proof_sha256 TEXT NOT NULL,envelope_json TEXT NOT NULL,",
          "FOREIGN KEY(challenge_hash) REFERENCES witness_challenges(challenge_hash));",
          "CREATE INDEX witness_source_idx ON witness_receipts(signature,source_hash,key_id);",
          "CREATE TRIGGER witness_challenges_no_delete BEFORE DELETE ON witness_challenges",
          "BEGIN SELECT RAISE(ABORT,'Witness challenge log retained'); END;",
          "CREATE TRIGGER witness_challenges_no_binding_change BEFORE UPDATE ON witness_challenges",
          "WHEN OLD.challenge_hash IS NOT NEW.challenge_hash OR OLD.source_json IS NOT NEW.source_json",
          "OR OLD.source_hash IS NOT NEW.source_hash OR OLD.key_id IS NOT NEW.key_id",
          "OR OLD.endpoint_id IS NOT NEW.endpoint_id OR OLD.genesis_hash IS NOT NEW.genesis_hash",
          "OR OLD.issued_at IS NOT NEW.issued_at OR OLD.expires_at IS NOT NEW.expires_at",
          "OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL",
          "BEGIN SELECT RAISE(ABORT,'Witness challenge binding immutable'); END;",
          "CREATE TRIGGER witness_receipt_no_update BEFORE UPDATE ON witness_receipts",
          "BEGIN SELECT RAISE(ABORT,'Witness receipt immutable'); END;",
          "CREATE TRIGGER witness_receipt_no_delete BEFORE DELETE ON witness_receipts",
          "BEGIN SELECT RAISE(ABORT,'Witness receipt immutable'); END;"
        ].join("\n"));
        db.prepare("INSERT INTO witness_config(id,recovery_epoch) VALUES(1,?)").run(recoveryEpoch);
        db.pragma("application_id="+APP_ID);db.pragma("user_version="+SCHEMA_VERSION);
      }).immediate();
    }
    if(db.pragma("application_id",{simple:true})!==APP_ID||
      db.pragma("user_version",{simple:true})!==SCHEMA_VERSION||
      db.prepare("SELECT recovery_epoch FROM witness_config WHERE id=1").get()?.recovery_epoch!==recoveryEpoch)
      throw Error("Witness DB schema or external recovery epoch mismatch");
    const names=["witness_challenges","witness_receipts","witness_config"];
    for(const name of names){
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
        throw Error("Witness DB missing required table: "+name);
    }
    for(const name of ["witness_challenges_no_delete","witness_challenges_no_binding_change",
      "witness_receipt_no_update","witness_receipt_no_delete"]){
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))
        throw Error("Witness journal integrity trigger missing");
    }
    if(db.pragma("journal_mode=WAL",{simple:true})!=="wal")
      throw Error("Witness WAL required");
    db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");
    return db;
  }catch(e){db.close();throw e;}
}
function sourceIdentity(source,kind,address,signature) {
  const result=aggregate(source,{signature,limit:1}).signatures[0];
  if(!result||result.status!=="PENDING_INDEPENDENT_FINALITY"||result.flags.length)
    throw Error("Source RAW or historical coverage not eligible for witness observation");
  const identities=result.recheck.rawRevisions.map(x=>({
    kind:x.kind,address:x.address,rawRevision:x.rawRevision,
    rawSha256:x.rawSha256,slot:x.slot
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const chosen=identities.find(x=>x.kind===kind&&x.address===address);
  if(!chosen)throw Error("Selected source target has no validated RAW");
  const details={kind,address,signature,slot:chosen.slot,rawRevision:chosen.rawRevision,
    rawSha256:chosen.rawSha256,revisionSetHash:sha(JSON.stringify(identities))};
  if(!validSource(details))throw Error("Incomplete exact source identity");
  return details;
}
function sourceSnapshot(source,fn){
  source.exec("BEGIN");
  let closed=false;
  try {
    // Source snapshot is finalized before a state transaction commits.
    const commit=()=>{source.exec("COMMIT");closed=true;};
    const result=fn(commit);
    // A fail-closed return may not call commit(); never leak BEGIN to caller.
    if(!closed)source.exec("ROLLBACK");
    return result;
  }catch(e){if(!closed){try{source.exec("ROLLBACK");}catch{}}throw e;}
}
function pinFor(pins,keyId){
  const match=validatePins(pins).find(x=>x.keyId===keyId);
  if(!match)throw Error("Witness key ID not independently pinned");
  return match;
}
function issue(source,state,{pins,keyId,kind,address,signature,clock=Date.now,ttlMs=60_000}={}){
  const pin=pinFor(pins,keyId);
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>300_000)
    throw Error("Invalid witness challenge TTL");
  return sourceSnapshot(source,commitSource=>state.transaction(()=>{
    const now=nowValue(clock),ident=sourceIdentity(source,kind,address,signature);
    const expiresAt=now+ttlMs;
    if(!Number.isSafeInteger(expiresAt))throw Error("Challenge TTL overflow");
    const challenge=randomBytes(32).toString("hex");
    state.prepare([
      "INSERT INTO witness_challenges",
      "(challenge_hash,source_json,source_hash,key_id,endpoint_id,genesis_hash,issued_at,expires_at)",
      "VALUES(?,?,?,?,?,?,?,?)"
    ].join(" ")).run(sha(challenge),JSON.stringify(ident),ident.revisionSetHash,pin.keyId,
      pin.endpointId,pin.genesisHash,now,expiresAt);
    commitSource();
    return {challenge,source:ident,keyId:pin.keyId,endpointId:pin.endpointId,
      genesisHash:pin.genesisHash,issuedAt:now,expiresAt,
      finalityVerified:false,pnlEligible:false};
  }).immediate());
}
function accept(source,state,{pins,envelope,clock=Date.now}={}){
  validatePins(pins);
  if(!envelope||typeof envelope.payload!=="string"||
     Buffer.byteLength(envelope.payload)>32*1024)return fail("witness_envelope_invalid");
  let payload;
  try{payload=JSON.parse(envelope.payload);}catch{return fail("witness_payload_not_json");}
  if(!HEX.test(payload?.challenge))return fail("invalid_witness_nonce");
  const pin=pins.find(x=>x.keyId===payload.keyId);
  if(!pin)return fail("untrusted_witness_key");
  const nonceHash=sha(payload.challenge);
  const challengeRow=state.prepare("SELECT * FROM witness_challenges WHERE challenge_hash=?").get(nonceHash);
  if(!challengeRow)return fail("witness_challenge_unknown");
  let original;
  try{original=JSON.parse(challengeRow.source_json);}catch{return fail("stored_source_binding_invalid");}
  const result=verifyReport(envelope,pin,{challenge:payload.challenge,source:original,now:nowValue(clock)});
  if(result.status!=="witness_reported_finalized")return result;
  // The source identity must still be CURRENT; a collector RAW correction or
  // another target revision invalidates an unconsumed witness challenge.
  return sourceSnapshot(source,commitSource=>state.transaction(()=>{
    const now=nowValue(clock);
    const old=state.prepare("SELECT * FROM witness_challenges WHERE challenge_hash=?").get(nonceHash);
    if(!old||old.consumed_at!==null)return fail("witness_challenge_already_used");
    if(now<old.issued_at||now>=old.expires_at||now-result.observedAt>300_000)
      return fail("witness_challenge_expired");
    if(payload.startedAt<old.issued_at||result.observedAt<old.issued_at)
      return fail("witness_report_precedes_challenge");
    if(old.source_json!==JSON.stringify(original)||old.key_id!==pin.keyId||
      old.endpoint_id!==pin.endpointId||old.genesis_hash!==pin.genesisHash)
      return fail("witness_challenge_binding_changed");
    let current;
    try{current=sourceIdentity(source,original.kind,original.address,original.signature);}
    catch{return fail("source_raw_changed_or_not_eligible");}
    if(JSON.stringify(current)!==JSON.stringify(original))
      return fail("source_raw_revision_superseded");
    const update=state.prepare([
      "UPDATE witness_challenges SET consumed_at=? WHERE challenge_hash=?",
      "AND consumed_at IS NULL AND issued_at<=? AND expires_at>? AND source_hash=?"
    ].join(" ")).run(now,nonceHash,now,now,original.revisionSetHash);
    if(update.changes!==1)return fail("challenge_compare_and_consume_failed");
    state.prepare([
      "INSERT INTO witness_receipts",
      "(challenge_hash,source_hash,key_id,endpoint_id,signature,raw_revision,raw_sha256,",
      "context_slot,observed_at,accepted_at,proof_sha256,envelope_json)",
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    ].join(" ")).run(nonceHash,original.revisionSetHash,pin.keyId,pin.endpointId,
      original.signature,original.rawRevision,original.rawSha256,
      result.contextSlot,result.observedAt,now,result.proofSha256,JSON.stringify(envelope));
    commitSource();
    return {status:"signed_witness_observation_stored",source:original,keyId:pin.keyId,
      endpointId:pin.endpointId,consensusFinalityVerified:false,pnlEligible:false};
  }).immediate());
}
function quorum(source,state,{pins,kind,address,signature}={}){
  let current;
  try{
    validatePins(pins);
    current=sourceIdentity(source,kind,address,signature);
  }catch{return fail("source_evidence_not_eligible_for_observation_quorum");}
  const raw=state.prepare([
    "SELECT c.source_json,c.issued_at,c.expires_at,r.key_id,r.endpoint_id,",
    "r.accepted_at,r.envelope_json FROM witness_receipts r",
    "JOIN witness_challenges c ON c.challenge_hash=r.challenge_hash",
    "WHERE r.signature=? AND r.source_hash=? ORDER BY r.id"
  ].join(" ")).all(signature,current.revisionSetHash);
  const witnesses=[];
  for(const row of raw){
    if(row.source_json!==JSON.stringify(current))continue;
    const pin=pins.find(x=>x.keyId===row.key_id&&x.endpointId===row.endpoint_id);
    if(!pin||witnesses.some(x=>x.keyId===pin.keyId||x.endpointId===pin.endpointId))continue;
    let envelope,payload;
    try{
      envelope=JSON.parse(row.envelope_json);
      payload=JSON.parse(envelope.payload);
    }catch{continue;}
    const checked=verifyReport(envelope,pin,{
      challenge:payload.challenge,source:current,now:row.accepted_at
    });
    if(checked.status==="witness_reported_finalized"&&
       checked.observedAt>=row.issued_at&&checked.observedAt<row.expires_at)
      witnesses.push({keyId:pin.keyId,endpointId:pin.endpointId,contextSlot:checked.contextSlot});
  }
  return {status:witnesses.length>=2?"two_pinned_witnesses_reported_finalized":
    "insufficient_independent_witness_reports",
    source:current,acceptedWitnessCount:witnesses.length,witnesses,
    consensusFinalityVerified:false,pnlEligible:false,
    limitations:["Two witness keys do not prove independent RPC backends, TLS acquisition or consensus finality.",
      "No reorg guarantee, historical inventory coverage, verified cost basis or PnL promotion."]};
}
module.exports={openWitnessState,issue,accept,quorum,sourceIdentity,sameFile};
