"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const ts=require("typescript");
const Database=require("better-sqlite3");
const {NextRequest,NextResponse}=require("next/server");
const {initDb}=require("./blockchain-seed-collector.cjs");
const {initForensics,REVISION}=require("./blockchain-forensics.cjs");
const dex=require("./blockchain-dex-index.cjs");
const db=new Database(":memory:");
const wallet="11111111111111111111111111111111";
const mint="So11111111111111111111111111111111111111112";
let allowed=false,reads=0;
const routeModule={exports:{}};
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,"../app/api/blockchain/evidence/route.ts"),"utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}
}).outputText;
const load=id=>{
  if(id==="@/lib/trade/db")return {getDb:()=>{reads++;return db;}};
  if(id==="@/lib/routeAuth")return {requireProdAuth:async()=>allowed?null:NextResponse.json({error:"Unauthorized"},{status:401})};
  if(id==="@/lib/rateLimit")return {checkRateLimit:()=>({success:true}),getClientIp:()=>"test"};
  if(id.endsWith("blockchain-forensics.cjs"))return {REVISION};
  if(id.endsWith("blockchain-dex-index.cjs"))return dex;
  return require(id);
};
vm.runInNewContext("(function(require,module,exports){"+source+"})")(load,routeModule,routeModule.exports);
const request=kind=>new NextRequest("http://localhost/api/blockchain/evidence?"+kind);
async function main(){
  initDb(db);initForensics(db);dex.initDexIndex(db);
  assert.equal((await routeModule.exports.GET(request("wallet="+wallet))).status,401);
  assert.equal(reads,0,"unauthenticated requests must not read private evidence");
  allowed=true;
  assert.equal((await routeModule.exports.GET(request("wallet=bad"))).status,400);
  db.prepare("INSERT INTO chain_forensic_wallet_sync(wallet,revision,observed_count,max_observed_at,coverage_complete,analyzed_at) VALUES(?,?,1,1,1,1)").run(wallet,REVISION);
  db.prepare("INSERT INTO chain_forensic_activities VALUES(?,?,0,1,1,'buy',?,1,2,0,NULL)").run(wallet,"fixture-signature",mint);
  db.prepare("INSERT INTO chain_forensic_wallet_pnl VALUES(?,?,1,'verified',1,1,0,1,1,1,'[]',1)").run(wallet,mint);
  const result=await (await routeModule.exports.GET(request("wallet="+wallet))).json();
  assert.equal(result.activities[0].wallet,wallet,"wallet UI requires an attributable address on every activity");
  assert.equal(result.pnl[0].totalRealizedPnlSol,1);
  const token=await (await routeModule.exports.GET(request("mint="+mint))).json();
  assert.equal(token.seedWalletTrades.length,1,"seed-only trades must remain visible without a DEX index");
  db.prepare("INSERT INTO chain_dex_observed_trades VALUES(?,?,?,?,'buy',1,1,1,2,0,1)").run(wallet,"dex-fixture",wallet,mint);
  db.prepare("INSERT INTO chain_dex_indexed_signatures VALUES(?,?,?,NULL,'observed')").run(wallet,"dex-fixture",dex.REVISION-1);
  assert.equal((await (await routeModule.exports.GET(request("mint="+mint))).json()).observedDexTrades.length,0);
  db.prepare("UPDATE chain_dex_indexed_signatures SET revision=?").run(dex.REVISION);
  assert.equal((await (await routeModule.exports.GET(request("mint="+mint))).json()).observedDexTrades.length,1);
  db.prepare("UPDATE chain_forensic_wallet_sync SET revision=?").run(REVISION-1);
  const old=await (await routeModule.exports.GET(request("wallet="+wallet))).json();
  assert.equal(old.pnl.length,0,"previous decoder revision cannot assert verified profit");
  assert.equal(old.activities.length,0);
  assert.equal((await (await routeModule.exports.GET(request("mint="+mint))).json()).seedWalletTrades.length,0);
  console.log("[blockchain-evidence-api] OK: auth before DB, address validation, wallet attribution, seed trades and decoder revision fencing");
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.close());
