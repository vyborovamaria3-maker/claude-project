"use strict";
const Database=require("better-sqlite3");
const {openSync,closeSync,realpathSync}=require("node:fs");
const {isAbsolute,resolve}=require("node:path");
const {randomBytes,createHash}=require("node:crypto");
const APP_ID=0x41523641; // AR6A: reference anchor, NEVER in the two-DB restore set
const hash=value=>createHash("sha256").update(value).digest("hex");
const hex=value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
function scopeFor(filename){
  if(typeof filename!=="string"||!isAbsolute(filename))throw new TypeError("absolute_anchor_scope_required");
  const path=resolve(filename);
  return hash(process.platform==="win32"?path.toLowerCase():path);
}
function createRpcRollbackAnchor(filename,{authorityFilename}={}){
  return connect(filename,authorityFilename,true);
}
function openRpcRollbackAnchor(filename){return connect(filename,null,false)}
/** Local reference implementation of an independently held monotonic CAS witness.
 * Its file/WAL and executable custody MUST be outside the two DB rollback domain.
 * A production adapter may replace it with an authenticated external CAS service.
 * This file is NOT hardware-backed or intrinsically immune to its own rollback.
 */
function connect(filename,authorityFilename,create){
  if(typeof filename!=="string"||!isAbsolute(filename))throw new TypeError("absolute_anchor_path_required");
  const scope=create?scopeFor(authorityFilename):null;
  if(create)closeSync(openSync(filename,"wx",0o600));
  const db=new Database(filename,{fileMustExist:true,timeout:1000});
  try{
    db.pragma("synchronous=FULL");
    if(create)db.transaction(()=>{
      db.exec(`CREATE TABLE anchor_log (
        sequence INTEGER PRIMARY KEY CHECK(sequence>=0),id TEXT NOT NULL,scope TEXT NOT NULL,
        previous_head TEXT NOT NULL,operation TEXT NOT NULL,salt TEXT NOT NULL,head TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TRIGGER anchor_no_update BEFORE UPDATE ON anchor_log
        BEGIN SELECT RAISE(ABORT,'Anchor is append only'); END;
      CREATE TRIGGER anchor_no_delete BEFORE DELETE ON anchor_log
        BEGIN SELECT RAISE(ABORT,'Anchor history retained'); END;
      CREATE TRIGGER anchor_no_replace BEFORE INSERT ON anchor_log
        WHEN NEW.sequence<>(SELECT COALESCE(MAX(sequence)+1,0) FROM anchor_log)
        BEGIN SELECT RAISE(ABORT,'Anchor sequence must advance'); END;`);
      const id=randomBytes(32).toString("hex"),salt=randomBytes(32).toString("hex");
      const head=hash(JSON.stringify([0,id,scope,"0".repeat(64),"bootstrap",salt]));
      db.prepare("INSERT INTO anchor_log VALUES(0,?,?,?,?,?,?)")
        .run(id,scope,"0".repeat(64),"bootstrap",salt,head);
      db.pragma("application_id="+APP_ID);db.pragma("user_version=1");
    }).immediate();
    if(db.pragma("application_id",{simple:true})!==APP_ID||db.pragma("user_version",{simple:true})!==1)
      throw new Error("dedicated_rollback_anchor_required");
    const validate=r=>{
      if(!r||!Number.isSafeInteger(r.sequence)||r.sequence<0||
         ![r.id,r.scope,r.previous_head,r.salt,r.head].every(hex)||
         !/^[a-z_]{1,32}$/.test(r.operation)||
         hash(JSON.stringify([r.sequence,r.id,r.scope,r.previous_head,r.operation,r.salt]))!==r.head)
        throw new Error("invalid_rollback_anchor");
      return {id:r.id,scope:r.scope,head:r.head,sequence:r.sequence};
    };
    const readHead=()=>validate(db.prepare("SELECT * FROM anchor_log ORDER BY sequence DESC LIMIT 1").get());
    // Validate the complete retained chain on open. No trimming/repair fallback.
    let previous;
    for(const r of db.prepare("SELECT * FROM anchor_log ORDER BY sequence").iterate()){
      validate(r);
      if(previous?(r.sequence!==previous.sequence+1||r.previous_head!==previous.head||r.id!==previous.id||r.scope!==previous.scope):
        (r.sequence!==0||r.previous_head!=="0".repeat(64)||r.operation!=="bootstrap"))
        throw new Error("invalid_rollback_anchor_chain");
      previous=r;
    }
    readHead();
    if(db.pragma("journal_mode=WAL",{simple:true})!=="wal")throw new Error("anchor_wal_required");
    db.pragma("synchronous=FULL");
    const advance=db.transaction(({expectedHead,scope:expectedScope,operation})=>{
      const current=readHead();
      if(!hex(expectedHead)||current.head!==expectedHead||current.scope!==expectedScope)
        throw new Error("rollback_anchor_compare_failed");
      if(typeof operation!=="string"||!/^[a-z_]{1,32}$/.test(operation))throw new TypeError("invalid_anchor_operation");
      const n=current.sequence+1,salt=randomBytes(32).toString("hex");
      if(!Number.isSafeInteger(n))throw new Error("anchor_sequence_exhausted");
      const head=hash(JSON.stringify([n,current.id,current.scope,current.head,operation,salt]));
      db.prepare("INSERT INTO anchor_log VALUES(?,?,?,?,?,?,?)")
        .run(n,current.id,current.scope,current.head,operation,salt,head);
      return readHead();
    });
    return {readHead,advance:record=>advance.immediate(record),
      storageFilename:realpathSync(filename),close:()=>db.close()};
  }catch(error){db.close();throw error}
}
module.exports={createRpcRollbackAnchor,openRpcRollbackAnchor,scopeFor};
