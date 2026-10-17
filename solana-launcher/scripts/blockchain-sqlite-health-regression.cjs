#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const Database=require("better-sqlite3");
const {main}=require("./blockchain-sqlite-health.cjs");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"solana-sqlite-check-"));
const file=path.join(dir,"trade.db");
(async()=>{
 const live=new Database(file);
 try {
   live.pragma("journal_mode=WAL");
   live.exec("CREATE TABLE evidence(signature TEXT PRIMARY KEY,payload TEXT NOT NULL)");
   live.prepare("INSERT INTO evidence(signature,payload) VALUES(?,?)").run("fixture","from-the-wal");
   const result=await main(["backup","--db",file]);
   assert.equal(result.integrity,"ok");
   assert.equal(result.tables,1);
   const snapshot=new Database(result.backup,{readonly:true,fileMustExist:true});
   try {
     assert.equal(snapshot.prepare("SELECT payload FROM evidence WHERE signature=?").get("fixture").payload,"from-the-wal");
   }finally{snapshot.close();}
   const checked=await main(["check","--db",file]);
   assert.equal(checked.integrity,"ok");
   console.log("[blockchain-sqlite-health-regression] OK: live WAL backup, verified integrity, restorable row");
 } finally {live.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
