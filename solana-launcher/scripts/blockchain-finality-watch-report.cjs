#!/usr/bin/env node
"use strict";
// Read-only bounded queue inspection; does not acknowledge or execute invalidations.
const fs=require("node:fs"),path=require("node:path");
const Database=require("better-sqlite3");
function review(db,{limit=50,afterId=0}={}){
  if(!Number.isInteger(limit)||limit<1||limit>200||
     !Number.isSafeInteger(afterId)||afterId<0)throw Error("Invalid review pagination");
  if(db.pragma("application_id",{simple:true})!==0x46495731||
     db.pragma("user_version",{simple:true})!==1)
    throw Error("Dedicated watcher state SQLite required");
  const pending=db.prepare("SELECT COUNT(*) n FROM watcher_invalidation_outbox").get().n;
  const rows=db.prepare([
    "SELECT id,scope,signature,previous_fingerprint,new_fingerprint,reason,created_at,state",
    "FROM watcher_invalidation_outbox WHERE id>? ORDER BY id LIMIT ?"
  ].join(" ")).all(afterId,limit);
  return {schema:"finality-watch-invalidation-review-v1",diagnosticOnly:true,
    autoApplied:false,pnlEligible:false,totalPending:pending,shown:rows.length,
    nextAfterId:rows.length?rows[rows.length-1].id:null,entries:rows,
    limitations:["Review-only queue, not an authenticated finality or reorg claim.",
      "No automatic cache invalidation, trade mutation, or financial promotion."]};
}
function parse(argv){
  const a={state:null,limit:50,afterId:0};
  for(let i=0;i<argv.length;i++){
    if(["--state","--limit","--after-id"].includes(argv[i])&&argv[i+1]){
      const key=argv[i]==="--after-id"?"afterId":argv[i].slice(2);
      a[key]=argv[++i];
    }
    else throw Error("Usage: --state existing-watch.db [--limit 50] [--after-id 0]");
  }
  if(!a.state)throw Error("Explicit --state required");
  a.limit=Number(a.limit);a.afterId=Number(a.afterId);
  return a;
}
function main(argv=process.argv.slice(2)){
  const args=parse(argv),p=path.resolve(args.state);
  if(!fs.existsSync(p))throw Error("Watch state does not exist");
  const db=new Database(p,{readonly:true,fileMustExist:true});
  try{db.pragma("query_only=ON");return review(db,args);}
  finally{db.close();}
}
if(require.main===module){
  try{console.log(JSON.stringify(main(),null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={review,parse,main};
