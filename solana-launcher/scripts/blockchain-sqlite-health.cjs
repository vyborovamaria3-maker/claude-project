#!/usr/bin/env node
"use strict";
// Laptop-first, WAL-aware SQLite Online Backup API. Never copy a live trade.db
// directly: data may reside in its -wal file while collection is active.
const fs=require("node:fs");
const path=require("node:path");
const Database=require("better-sqlite3");
async function main(args=process.argv.slice(2)) {
  const mode=args[0] || "check";
  if (!["check","backup"].includes(mode)) throw new Error("Usage: blockchain:db-health [check|backup] [--db existing.db]");
  const at=args.indexOf("--db");
  if (at>=0 && !args[at+1]) throw new Error("Missing --db path");
  const dbPath=path.resolve(at>=0?args[at+1]:path.join(process.cwd(),"data","trade.db"));
  if (!fs.existsSync(dbPath)) throw new Error("SQLite database not found: "+dbPath);
  const source=new Database(dbPath,{readonly:true,fileMustExist:true});
  try {
    source.pragma("busy_timeout=10000");
    const check=source.pragma("integrity_check",{simple:true});
    if (check !== "ok") throw new Error("Source SQLite integrity_check failed: "+String(check));
    if (mode === "check") {
      return {mode,integrity:"ok",database:dbPath,bytes:fs.statSync(dbPath).size};
    }
    const dir=path.join(path.dirname(dbPath),"sqlite-backups");
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const stamp=new Date().toISOString().replace(/[^0-9A-Za-z]/g,"-");
    const dest=path.join(dir,"trade-"+stamp+"-"+process.pid+".db");
    if (fs.existsSync(dest)) throw new Error("Backup destination already exists");
    await source.backup(dest);
    fs.chmodSync(dest,0o600);
    const verify=new Database(dest,{readonly:true,fileMustExist:true});
    try {
      const result=verify.pragma("integrity_check",{simple:true});
      if (result!=="ok") throw new Error("Backup integrity_check failed: "+String(result));
      const sources=verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
      return {mode,integrity:"ok",backup:dest,bytes:fs.statSync(dest).size,tables:sources};
    } finally {verify.close();}
  } finally {source.close();}
}
if (require.main===module) main().then(x=>console.log(JSON.stringify(x,null,2)))
  .catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
module.exports={main};
