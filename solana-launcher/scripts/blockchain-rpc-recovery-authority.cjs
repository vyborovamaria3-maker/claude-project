"use strict";
const Database=require("better-sqlite3");
const {openSync,closeSync,realpathSync,existsSync,statSync}=require("node:fs");
const {isAbsolute,dirname,basename,join}=require("node:path");
const {randomBytes}=require("node:crypto");
const {openRpcChallengeStore,recoverRpcChallengeStore}=require("./blockchain-rpc-challenge-store.cjs");
const {scopeFor}=require("./blockchain-rpc-rollback-anchor.cjs");
const APP_ID=0x41523647; // AR6G, separate from the challenge DB
const epoch=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
function canonical(file){
  if(typeof file!=="string"||!isAbsolute(file))throw new TypeError("absolute_recovery_path_required");
  const value=existsSync(file)?realpathSync(file):join(realpathSync(dirname(file)),basename(file));
  return process.platform==="win32"?value.toLowerCase():value;
}
function distinct(a,b){
  if(canonical(a)===canonical(b))throw new Error("separate_recovery_database_required");
  if(existsSync(a)&&existsSync(b)){
    const x=statSync(a),y=statSync(b);
    if(x.dev===y.dev&&x.ino===y.ino)throw new Error("separate_recovery_database_required");
  }
}
function createRpcRecoveryAuthority(filename,options={}){
  return connect(filename,options,true);
}
function openRpcRecoveryAuthority(filename,options={}){
  return connect(filename,options,false);
}
/** The authority file MUST be outside the challenge backup/restore domain.
 * Missing/corrupt authorities are never automatically recreated. No environment
 * lookup, network, secrets, backup copying or source DB discovery is performed.
 */
function connect(filename,{challengeFilename,clock=Date.now,anchor,allowAnchorRecovery=false},create){
  const authorityPath=canonical(filename);
  if(typeof clock!=="function")throw new TypeError("trusted_recovery_clock_required");
  if(create){
    distinct(filename,challengeFilename);
    // Exclusive creation prevents accidental replacement or adoption of an old DB.
    closeSync(openSync(filename,"wx",0o600));
  }
  const db=new Database(filename,{fileMustExist:true,timeout:1000});
  const time=()=>{
    const n=clock();
    if(!Number.isSafeInteger(n)||n<0)throw new Error("invalid_recovery_clock");
    return n;
  };
  try{
    db.pragma("synchronous=FULL");
    if(create){
      db.transaction(()=>{
        db.exec(`CREATE TABLE recovery_state (
          id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL CHECK(length(epoch)=64),
          phase TEXT NOT NULL CHECK(phase IN ('active','recovering')),
          challenge_path TEXT NOT NULL,authority_path TEXT NOT NULL
        ) STRICT;
        CREATE TABLE recovery_history (
          epoch TEXT PRIMARY KEY CHECK(length(epoch)=64),previous_epoch TEXT,changed_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER recovery_history_no_update BEFORE UPDATE ON recovery_history
          BEGIN SELECT RAISE(ABORT,'Recovery history is immutable'); END;
        CREATE TRIGGER recovery_history_no_delete BEFORE DELETE ON recovery_history
          BEGIN SELECT RAISE(ABORT,'Recovery history is retained'); END;
        CREATE TRIGGER recovery_history_no_replace BEFORE INSERT ON recovery_history
          WHEN EXISTS(SELECT 1 FROM recovery_history WHERE epoch=NEW.epoch)
          BEGIN SELECT RAISE(ABORT,'Recovery epoch already exists'); END;`);
        const initial=randomBytes(32).toString("hex");
        db.prepare("INSERT INTO recovery_state VALUES(1,?,'active',?,?)")
          .run(initial,canonical(challengeFilename),authorityPath);
        db.prepare("INSERT INTO recovery_history VALUES(?,NULL,?)").run(initial,time());
        if(anchor){
          const head=readAnchor();
          if(head.sequence!==0)throw new Error("anchor_bootstrap_not_fresh");
          db.exec("CREATE TABLE recovery_anchor (id INTEGER PRIMARY KEY CHECK(id=1),anchor_id TEXT NOT NULL,head TEXT NOT NULL,sequence INTEGER NOT NULL) STRICT");
          db.prepare("INSERT INTO recovery_anchor VALUES(1,?,?,?)").run(head.id,head.head,head.sequence);
        }
        db.pragma("application_id="+APP_ID);db.pragma("user_version=1");
      }).immediate();
    }
    if(db.pragma("application_id",{simple:true})!==APP_ID||db.pragma("user_version",{simple:true})!==1)
      throw new Error("dedicated_recovery_authority_required");
    const row=()=>{
      const s=db.prepare("SELECT * FROM recovery_state WHERE id=1").get();
      if(!s||!epoch(s.epoch)||!["active","recovering"].includes(s.phase)||s.authority_path!==authorityPath)
        throw new Error("invalid_recovery_authority_state");
      distinct(filename,s.challenge_path);
      return s;
    };
    row();
    const anchored=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_anchor'").get();
    if(anchored&&!anchor)throw new Error("independent_rollback_anchor_required");
    if(anchor&&!anchored)throw new Error("explicit_anchored_bootstrap_required");
    function readAnchor(){
      if(!anchor||typeof anchor.readHead!=="function"||typeof anchor.advance!=="function")
        throw new Error("independent_rollback_anchor_required");
      const h=anchor.readHead();
      if(!h||![h.id,h.head,h.scope].every(epoch)||!Number.isSafeInteger(h.sequence)||h.sequence<0||
         h.scope!==scopeFor(authorityPath))throw new Error("rollback_anchor_scope_invalid");
      if(anchor.storageFilename){
        distinct(filename,anchor.storageFilename);
        distinct(create?challengeFilename:row().challenge_path,anchor.storageFilename);
      }
      return h;
    }
    function checkAnchor(permitMismatch=false){
      if(!anchored)return null;
      const saved=db.prepare("SELECT * FROM recovery_anchor WHERE id=1").get(),h=readAnchor();
      if(!saved||saved.anchor_id!==h.id||h.sequence<saved.sequence||
         (h.sequence===saved.sequence&&h.head!==saved.head))throw new Error("rollback_anchor_regressed_or_replaced");
      if(!permitMismatch&&(saved.head!==h.head||saved.sequence!==h.sequence))throw new Error("joint_store_rollback_or_interrupted_commit");
      return h;
    }
    db.transaction(()=>checkAnchor(allowAnchorRecovery)).immediate();
    function mutate(operation,callback,permitMismatch=false,preflight){
      return db.transaction((...args)=>{
        const before=checkAnchor(permitMismatch);
        if(preflight)preflight(...args);
        const next=before?anchor.advance({expectedHead:before.head,scope:before.scope,operation}):null;
        if(before){
          const actual=readAnchor();
          if(!next||actual.id!==before.id||actual.head!==next.head||actual.head===before.head||
             actual.sequence!==before.sequence+1)throw new Error("rollback_anchor_advance_invalid");
        }
        const result=callback(...args);
        if(next){
          const actual=readAnchor();
          if(actual.id!==before.id||actual.head!==next.head||actual.sequence!==before.sequence+1)
            throw new Error("rollback_anchor_advance_invalid");
          db.prepare("UPDATE recovery_anchor SET head=?,sequence=? WHERE id=1").run(actual.head,actual.sequence);
        }
        return result;
      });
    }
    if(db.pragma("journal_mode=WAL",{simple:true})!=="wal")throw new Error("recovery_wal_required");
    db.pragma("synchronous=FULL");
    const summary=s=>({epoch:s.epoch,phase:s.phase});
    const active=expected=>{
      const s=row();
      if(s.phase!=="active"||(expected!==undefined&&s.epoch!==expected))
        throw new Error("recovery_authority_not_active_or_stale");
      return s;
    };
    function challenges(createFile){
      const transaction=(createFile?callback=>mutate("create_challenges",callback,false,()=>active()):callback=>db.transaction(()=>{
        checkAnchor();return callback();
      }));
      return transaction(()=>{
        const s=active();
        if(createFile)closeSync(openSync(s.challenge_path,"wx",0o600));
        const store=openRpcChallengeStore(s.challenge_path,{
          recoveryEpoch:s.epoch,clock,fileMustExist:true,allowInitialize:createFile,
        });
        const issue=mutate("issue",(binding,ttl)=>{
          active(s.epoch);return store.issue(binding,ttl);
        },false,()=>active(s.epoch));
        const consume=mutate("consume",record=>{
          active(s.epoch);return store.consumeChallenge(record);
        },false,()=>active(s.epoch));
        // Lock ordering is always authority -> challenge. Rotation cannot race
        // past an authorized challenge commit. Old handles fail after rotation.
        return {issue:(binding,ttl)=>issue.immediate(binding,ttl),
          consumeChallenge:record=>consume.immediate(record),close:()=>store.close()};
      }).immediate();
    }
    return {
      status:()=>db.transaction(()=>{checkAnchor();return summary(row())}).immediate(),
      recoveryStatus:()=>{
        if(!allowAnchorRecovery||!anchored)throw new Error("explicit_anchor_recovery_mode_required");
        return db.transaction(()=>({ ...summary(row()),anchor:checkAnchor(true) })).immediate();
      },
      beginAnchoredRecovery:(expectedEpoch,expectedAnchorHead)=>{
        if(!allowAnchorRecovery||!anchored)throw new Error("explicit_anchor_recovery_mode_required");
        return db.transaction(()=>{
          const current=checkAnchor(true);
          if(!epoch(expectedAnchorHead)||current.head!==expectedAnchorHead)
            throw new Error("rollback_anchor_compare_failed");
          if(row().epoch!==expectedEpoch)throw new Error("recovery_authority_epoch_mismatch");
          return mutate("recover_rollback",()=>{
            const s=row(),next=randomBytes(32).toString("hex");
            db.prepare("INSERT INTO recovery_history VALUES(?,?,?)").run(next,s.epoch,time());
            db.prepare("UPDATE recovery_state SET epoch=?,phase='recovering' WHERE id=1").run(next);
            return summary(row());
          },true).immediate();
        }).immediate();
      },
      createChallenges:()=>challenges(true),
      openChallenges:()=>challenges(false),
      beginRecovery:expectedEpoch=>mutate("begin_recovery",()=>{
        if(!epoch(expectedEpoch))throw new TypeError("expected_recovery_epoch_required");
        const s=active(expectedEpoch),next=randomBytes(32).toString("hex");
        // Unique history prevents generation reuse. Never accept an imported epoch.
        db.prepare("INSERT INTO recovery_history VALUES(?,?,?)").run(next,s.epoch,time());
        db.prepare("UPDATE recovery_state SET epoch=?,phase='recovering' WHERE id=1").run(next);
        return summary(row());
      },false,()=>{
        if(!epoch(expectedEpoch))throw new TypeError("expected_recovery_epoch_required");
        active(expectedEpoch);
      }).immediate(),
      finishRecovery:(expectedEpoch,previousEpoch)=>mutate("finish_recovery",()=>{
        const s=row();
        if(!epoch(expectedEpoch)||s.epoch!==expectedEpoch)throw new Error("recovery_authority_epoch_mismatch");
        let store;
        try{
          try{
            // Resume after a committed SQLite recovery and lost authority ACK.
            store=openRpcChallengeStore(s.challenge_path,{
              recoveryEpoch:s.epoch,clock,fileMustExist:true,allowInitialize:false,
            });
          }catch(error){
            if(s.phase!=="recovering"||!["challenge_recovery_epoch_mismatch","challenge_recovery_required"].includes(error.message))
              throw error;
            store=recoverRpcChallengeStore(s.challenge_path,{
              recoveryEpoch:s.epoch,previousEpoch,clock,
            });
          }
        }finally{if(store)store.close()}
        db.prepare("UPDATE recovery_state SET phase='active' WHERE id=1").run();
        return summary(row());
      },false,()=>{
        if(!epoch(expectedEpoch)||row().epoch!==expectedEpoch)throw new Error("recovery_authority_epoch_mismatch");
      }).immediate(),
      close:()=>db.close(),
    };
  }catch(error){db.close();throw error}
}
module.exports={createRpcRecoveryAuthority,openRpcRecoveryAuthority};
