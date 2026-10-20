"use strict";
const Database=require("better-sqlite3");
const {isAbsolute}=require("node:path");
const {randomBytes,createHash}=require("node:crypto");
const APPLICATION_ID=0x41523643; // AR6C: dedicated DB, never collector trade.db
const VERSION=2;
const validEpoch=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const label=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(v);
const validBinding=r=>r&&typeof r.eventKey==="string"&&r.eventKey.length<=1024&&
  /^[A-Za-z0-9:_-]+$/.test(r.eventKey)&&label(r.keyId)&&label(r.endpointId)&&
  typeof r.genesisHash==="string"&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.genesisHash);
const digest=v=>createHash("sha256").update(v).digest("hex");

/** Explicit dedicated file only. No default path, env loading or live DB discovery.
 * clock is a trusted verifier clock; injection exists for isolated deterministic tests.
 * recoveryEpoch MUST come from trusted configuration OUTSIDE the DB backup domain.
 * Stop all workers, advance that external pin, then explicitly recover a restored DB.
 * Silent rollback within the same epoch cannot be detected by SQLite alone.
 */
function openRpcChallengeStore(filename,options={}){
  return openStore(filename,options,false);
}
// Call only with workers stopped and a new, out-of-band recovery epoch.
function recoverRpcChallengeStore(filename,options={}){
  return openStore(filename,options,true);
}
function openStore(filename,{clock=Date.now,recoveryEpoch,previousEpoch},recover){
  if(typeof filename!=="string"||!isAbsolute(filename)||typeof clock!=="function")
    throw new TypeError("explicit_absolute_challenge_database_required");
  if(!validEpoch(recoveryEpoch)||
     (recover&&previousEpoch!==null&&!validEpoch(previousEpoch))||
     (recover&&previousEpoch===recoveryEpoch))
    throw new TypeError("independent_recovery_epoch_required");
  const db=new Database(filename,{timeout:1000,fileMustExist:recover});
  try{
    db.pragma("synchronous=FULL");
    db.transaction(()=>{
      const app=db.pragma("application_id",{simple:true});
      const version=db.pragma("user_version",{simple:true});
      const objects=db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n;
      if(!recover&&app===0&&version===0&&objects===0){
        db.exec(`CREATE TABLE rpc_challenges (
          challenge_hash TEXT PRIMARY KEY CHECK(length(challenge_hash)=64),
          recovery_epoch TEXT,
          event_key TEXT NOT NULL,key_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,
          genesis_hash TEXT NOT NULL,issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
          consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at>=issued_at)
        ) STRICT;
        CREATE TRIGGER rpc_challenge_no_delete BEFORE DELETE ON rpc_challenges
          BEGIN SELECT RAISE(ABORT,'Challenge history is retained'); END;
        CREATE TRIGGER rpc_challenge_fence BEFORE UPDATE ON rpc_challenges
          WHEN OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
            OR NEW.challenge_hash IS NOT OLD.challenge_hash OR NEW.event_key IS NOT OLD.event_key
            OR NEW.key_id IS NOT OLD.key_id OR NEW.endpoint_id IS NOT OLD.endpoint_id
            OR NEW.genesis_hash IS NOT OLD.genesis_hash OR NEW.issued_at IS NOT OLD.issued_at
            OR NEW.expires_at IS NOT OLD.expires_at OR NEW.recovery_epoch IS NOT OLD.recovery_epoch
          BEGIN SELECT RAISE(ABORT,'Challenge binding is immutable'); END;
        CREATE TRIGGER rpc_challenge_no_replace BEFORE INSERT ON rpc_challenges
          WHEN EXISTS(SELECT 1 FROM rpc_challenges WHERE challenge_hash=NEW.challenge_hash)
          BEGIN SELECT RAISE(ABORT,'Challenge identity already exists'); END;`);
        db.exec("CREATE TABLE rpc_challenge_generation (id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL CHECK(length(epoch)=64)) STRICT");
        db.prepare("INSERT INTO rpc_challenge_generation VALUES(1,?)").run(recoveryEpoch);
        db.pragma("application_id="+APPLICATION_ID);
        db.pragma("user_version="+VERSION);
      }else if(app!==APPLICATION_ID||![1,VERSION].includes(version)){
        throw new Error("dedicated_challenge_schema_required");
      }else{
        if(version===1){
          if(!recover||previousEpoch!==null)throw new Error("challenge_recovery_required");
          // Legacy challenge bytes have no external generation. Preserve for audit,
          // but NULL epoch means every legacy nonce is permanently ineligible.
          db.exec("ALTER TABLE rpc_challenges ADD COLUMN recovery_epoch TEXT;"+
            "CREATE TABLE rpc_challenge_generation (id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL CHECK(length(epoch)=64)) STRICT;");
          db.prepare("INSERT INTO rpc_challenge_generation VALUES(1,?)").run(recoveryEpoch);
          db.exec("CREATE TRIGGER rpc_challenge_epoch_immutable BEFORE UPDATE OF recovery_epoch ON rpc_challenges "+
            "WHEN NEW.recovery_epoch IS NOT OLD.recovery_epoch BEGIN SELECT RAISE(ABORT,'Challenge binding is immutable'); END");
          db.pragma("user_version="+VERSION);
        }else{
          const stored=db.prepare("SELECT epoch FROM rpc_challenge_generation WHERE id=1").get()?.epoch;
          if(recover){
            if(stored!==previousEpoch)throw new Error("challenge_recovery_compare_failed");
            db.prepare("UPDATE rpc_challenge_generation SET epoch=? WHERE id=1 AND epoch=?")
              .run(recoveryEpoch,previousEpoch);
          }else if(stored!==recoveryEpoch)throw new Error("challenge_recovery_epoch_mismatch");
        }
      }
    }).immediate();
    if(db.pragma("journal_mode=WAL",{simple:true})!=="wal")
      throw new Error("challenge_wal_required");
    db.pragma("synchronous=FULL");
    const insert=db.prepare(`INSERT INTO rpc_challenges
      (challenge_hash,event_key,key_id,endpoint_id,genesis_hash,issued_at,expires_at,recovery_epoch)
      VALUES(?,?,?,?,?,?,?,?)`);
    const consume=db.prepare(`UPDATE rpc_challenges SET consumed_at=?
      WHERE challenge_hash=? AND event_key=? AND key_id=? AND endpoint_id=? AND genesis_hash=?
        AND consumed_at IS NULL AND issued_at<=? AND expires_at>?
        AND recovery_epoch=? AND EXISTS(SELECT 1 FROM rpc_challenge_generation WHERE id=1 AND epoch=?)`);
    const issue=db.transaction((binding,ttlMs)=>{
      const generation=db.prepare("SELECT epoch FROM rpc_challenge_generation WHERE id=1").get()?.epoch;
      if(generation!==recoveryEpoch)throw new Error("challenge_recovery_epoch_mismatch");
      const now=time(),expiresAt=now+ttlMs;
      if(!Number.isSafeInteger(expiresAt))throw new TypeError("invalid_challenge_expiry");
      const challenge=randomBytes(32).toString("hex");
      insert.run(digest(challenge),binding.eventKey,binding.keyId,binding.endpointId,
        binding.genesisHash,now,expiresAt,recoveryEpoch);
      return {challenge,issuedAt:now,expiresAt};
    });
    function time(){
      const value=clock();
      if(!Number.isSafeInteger(value)||value<0)throw new Error("invalid_challenge_clock");
      return value;
    }
    return {
      issue(binding,ttlMs=60_000){
        if(!validBinding(binding)||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>300_000)
          throw new TypeError("invalid_challenge_binding_or_ttl");
        // Immediate transaction fences generation rotation against concurrent issue.
        return issue.immediate(binding,ttlMs);
      },
      consumeChallenge(record){
        if(!validBinding(record)||typeof record.challenge!=="string"||
           !/^[a-f0-9]{64}$/.test(record.challenge)||!Number.isSafeInteger(record.now))return false;
        const now=time(); // independently re-read at consumption, never trust a stale record.now
        if(record.now>now)return false;
        // One autocommitted conditional UPDATE: concurrent connections cannot both win.
        return consume.run(now,digest(record.challenge),record.eventKey,record.keyId,
          record.endpointId,record.genesisHash,record.now,now,recoveryEpoch,recoveryEpoch).changes===1;
      },
      close(){db.close()},
    };
  }catch(error){db.close();throw error}
}
module.exports={openRpcChallengeStore,recoverRpcChallengeStore};
