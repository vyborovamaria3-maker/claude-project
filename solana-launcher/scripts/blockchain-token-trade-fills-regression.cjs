#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const Database=require("better-sqlite3");
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"solana-trade-fills-"));
const initial=process.cwd();
const oldDb=path.join(temp,"data","trade.db");
fs.mkdirSync(path.dirname(oldDb),{recursive:true});
// Simulate an actual pre-upgrade laptop database, not a clean schema.
{
 const legacy=new Database(oldDb);
 try {
  legacy.exec("CREATE TABLE token_trades (mint TEXT NOT NULL,signature TEXT NOT NULL,timestamp INTEGER NOT NULL,trader TEXT NOT NULL,type TEXT NOT NULL,amount_sol REAL NOT NULL,amount_tokens REAL NOT NULL,price_sol REAL NOT NULL,source TEXT,inserted_at INTEGER NOT NULL,PRIMARY KEY(mint,signature))");
  legacy.prepare("INSERT INTO token_trades(mint,signature,timestamp,trader,type,amount_sol,amount_tokens,price_sol,source,inserted_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("mint","shared-signature",5,"prior-trader","sell",2,20,0.1,"legacy",1);
 }finally{legacy.close();}
}
process.chdir(temp);
require("ts-node").register({skipProject:true,transpileOnly:true,compilerOptions:{module:"commonjs",moduleResolution:"node",esModuleInterop:true}});
const {getDb,persistTokenTrades,getTokenTrades}=require("../lib/trade/db");
// The module above is resolved relative to this test script, not temp cwd.
const db=getDb();
try {
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM token_trades").get().n,1,"old rows must survive additive migration");
 assert(db.pragma("table_info(token_trades)").some(c=>c.name==="quote_mint"),"old columns upgraded in place");
 const base={signature:"shared-signature",timestamp:10,slot:100,trader:"trader-A",type:"buy",amountSol:1,amountTokens:10,priceSol:0.1,source:"mock"};
 persistTokenTrades("mint",[{...base,legIndex:0},{...base,legIndex:1,trader:"trader-B",type:"sell",amountSol:2}]);
 let rows=getTokenTrades("mint");
 assert.equal(rows.length,2,"two legitimate legs from same tx must both be represented");
 assert.deepEqual(rows.map(x=>x.legIndex),[0,1]);
 assert.deepEqual(rows.map(x=>x.trader),["trader-A","trader-B"]);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM token_trades").get().n,1,"original legacy row intact");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM token_trade_fills").get().n,2);
 persistTokenTrades("mint",[{...base,legIndex:0,amountTokens:12},{...base,legIndex:1,trader:"trader-B",type:"sell",amountSol:2}]);
 rows=getTokenTrades("mint");
 assert.equal(rows.length,2,"replays must upsert fills instead of doubling");
 assert.equal(rows[0].amountTokens,12);
 const revision=db.prepare("SELECT revision FROM database_source_revisions WHERE name='token_trade_fills'").get().revision;
 assert(revision>=4,"indexed fills must invalidate materialized caches on UPSERT");
 assert.throws(()=>persistTokenTrades("mint",[{...base,legIndex:3},{...base,legIndex:3}]),/Duplicate leg index/);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM token_trade_fills").get().n,2,"failed batch remains untouched");
 assert.throws(()=>persistTokenTrades("mint",[{...base,legIndex:-1}]),/non-negative safe integer/);
 persistTokenTrades("mint",[{...base,signature:"legacy-only",trader:"older",legIndex:undefined}]);
 rows=getTokenTrades("mint");
 assert.equal(rows.length,3,"legacy-only signatures remain readable alongside normalized fills");
 assert.equal(rows.filter(x=>x.signature==="legacy-only").length,1);
 console.log("[blockchain-token-trade-fills-regression] OK: pre-upgrade database, multiple legs, legacy fallback, replay, revision, transaction guards");
}finally{db.close();global.__TRADE_DB__=undefined;process.chdir(initial);fs.rmSync(temp,{recursive:true,force:true});}