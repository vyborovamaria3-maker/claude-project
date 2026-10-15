#!/usr/bin/env node
"use strict";
// Purely local replay of persisted DEX program Enhanced Transactions evidence.
const path=require("node:path");
require("dotenv").config({path:path.join(process.cwd(),".env.local"),quiet:true});
require("dotenv").config({path:path.join(process.cwd(),".env"),quiet:true});
const {replayProgram,configuredDexPrograms,initDexIndex}=require("./blockchain-dex-index.cjs");
const args=process.argv.slice(2);
const at=args.indexOf("--limit");
const limit=at<0?10000:Number(args[at+1]);
if(!Number.isSafeInteger(limit)||limit<1||limit>100000) throw new Error("--limit 1..100000");
if(args.some((value,i)=>value==="--limit"?i===args.length-1:false)) throw new Error("Missing --limit value");
require("ts-node").register({skipProject:true,transpileOnly:true,
  compilerOptions:{module:"commonjs",moduleResolution:"node",esModuleInterop:true}});
const db=require("../lib/trade/db").getDb();
initDexIndex(db);
const existing=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chain_seed_events'").get();
if(!existing){console.log(JSON.stringify({programs:[],message:"No persisted Helius seed events yet"}));process.exit(0);}
const programs=configuredDexPrograms();
const output=programs.map(program=>replayProgram(db,program,limit));
console.log(JSON.stringify({programs:output,source:"cached transactions only",networkCalls:0},null,2));
