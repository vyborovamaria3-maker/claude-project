#!/usr/bin/env node
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import pg from "pg";
import {parseTokenId} from "@claude-project/contracts";
import {parseApiRequest,queryTokenApi} from "../api/routes.mjs";
import {checkApiReadiness} from "../api/server.mjs";
import {composeLocalTokenReport,formatLocalTokenReport} from "./local-token-report-core.mjs";

export const USAGE=[
  "Offline/local token evidence report; no X/TG/RPC, HTTP server or AI model.",
  "  npm --prefix intelligence run token:report -- --mint <Solana mint> --demo",
  "  INTELLIGENCE_LOCAL_READ_ENABLED=true INTELLIGENCE_DATABASE_URL=postgresql://localhost:5432/intelligence_test",
  "    npm --prefix intelligence run token:report -- --mint <Solana mint> --json",
  "  Options: --known-at YYYY-MM-DDTHH:MM:SSZ --occurred-before ... --limit 1..100 --json --demo",
  "  --demo is SYNTHETIC and needs no DB. Real read requires loopback PostgreSQL only.",
].join("\n");

function iso(value,name){
  if(typeof value!=="string"||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    throw new TypeError("invalid_"+name);
  const d=new Date(value);
  if(!Number.isFinite(d.getTime()))throw new TypeError("invalid_"+name);
  const canonical=value.includes(".")
    ?value.replace(/\.(\d{1,2})Z$/,(_,ms)=>"."+ms.padEnd(3,"0")+"Z")
    :value.replace(/Z$/,".000Z");
  if(d.toISOString()!==canonical)throw new TypeError("invalid_"+name);
  return d.toISOString();
}
export function parseLocalTokenArgs(argv,now=new Date()){
  if(!Array.isArray(argv)||argv.length>30)throw new TypeError("invalid_arguments");
  const o={mint:null,knownAt:null,occurredBefore:null,limit:20,json:false,demo:false,help:false};
  const single=new Set();
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==="--help"||arg==="-h")o.help=true;
    else if(arg==="--json"||arg==="--demo"){
      if(single.has(arg))throw new TypeError("duplicate_option");
      single.add(arg);o[arg.slice(2)]=true;
    }else if(["--mint","--known-at","--occurred-before","--limit"].includes(arg)){
      if(single.has(arg)||!argv[i+1]||argv[i+1].startsWith("--"))
        throw new TypeError("missing_or_duplicate_option");
      single.add(arg);
      const value=argv[++i];
      if(arg==="--mint")o.mint=value;
      if(arg==="--known-at")o.knownAt=value;
      if(arg==="--occurred-before")o.occurredBefore=value;
      if(arg==="--limit")o.limit=Number(value);
    }else throw new TypeError("unknown_option");
  }
  if(o.help)return {help:true};
  if(typeof o.mint!=="string")throw new TypeError("mint_required");
  const tokenId=o.mint.startsWith("solana:")?o.mint:"solana:"+o.mint;
  if(parseTokenId(tokenId)?.id!==tokenId||!tokenId.startsWith("solana:"))
    throw new TypeError("canonical_solana_mint_required");
  const knownAt=o.knownAt?iso(o.knownAt,"known_at"):now.toISOString();
  const occurredBefore=o.occurredBefore?iso(o.occurredBefore,"occurred_before"):knownAt;
  if(knownAt>now.toISOString()||occurredBefore>knownAt)
    throw new TypeError("future_or_inverted_window");
  if(!Number.isInteger(o.limit)||o.limit<1||o.limit>100)
    throw new RangeError("limit_1_to_100");
  return {
    tokenId,knownAt,occurredBefore,limit:o.limit,json:o.json,demo:o.demo,
  };
}
export function assertLocalDestination(env=process.env){
  if(env.INTELLIGENCE_LOCAL_READ_ENABLED!=="true")
    throw new Error("local_read_explicit_opt_in_required");
  const raw=env.INTELLIGENCE_DATABASE_URL;
  if(typeof raw!=="string")throw new Error("local_postgres_required");
  let url;
  try{url=new URL(raw)}catch{throw new Error("local_postgres_required")}
  if(!["postgres:","postgresql:"].includes(url.protocol)||
     !["localhost","127.0.0.1","[::1]"].includes(url.hostname)||
     !url.pathname||url.pathname==="/"||url.search||url.hash){
    throw new Error("loopback_postgres_only");
  }
  return raw;
}
function parseQuery(kind,options,now){
  const params=new URLSearchParams({
    occurredBefore:options.occurredBefore,knownAt:options.knownAt,
    limit:String(options.limit),
  });
  return parseApiRequest("/api/intelligence/v1/tokens/"+
    encodeURIComponent(options.tokenId)+"/"+kind+"?"+params,now);
}
function syntheticFixture(options){
  const {tokenId,occurredBefore,knownAt,limit}=options;
  const base={
    schemaVersion:"token-intelligence-v1",tokenId,
    occurredBefore,knownAt,historicalCompleteness:"unknown",
    coverage:"observed_and_qualified_events_only",truncated:false,
  };
  return {
    evidence:{
      ...base,items:[],sourceScope:"separate_social_and_chain_evidence",
      independentLimitPerSourceType:limit,
      socialLinksTruncated:false,blockchainSwapEvidenceTruncated:false,
      tradeStatus:"not_a_confirmed_trade_tape",
      blockchainFinality:"not_independently_verified",
      socialLinks:[{
        source:"x",evidenceId:"x:tweet:synthetic_fixture_1",
        occurredAt:occurredBefore,observedAt:knownAt,
        verification:"source_verified_spl_mint_account",
      },{
        source:"tg",evidenceId:"tg:message:synthetic_fixture_2",
        occurredAt:occurredBefore,observedAt:knownAt,
        verification:"source_verified_spl_mint_account",
      }].slice(0,limit),
      blockchainSwapEvidence:[{
        source:"blockchain",evidenceId:"chain:tx:solana:synthetic_fixture_3",
        occurredAt:occurredBefore,observedAt:knownAt,
        attribution:"provider_parsed_wallet_swap",
        finality:"not_independently_verified",tradeCompleteness:"unknown",
      }].slice(0,limit),
    },
    timeline:{...base,items:[]},
  };
}
export async function makeLocalReport(options,{
  env=process.env,now=new Date(),makePool=(config)=>new pg.Pool(config),
}={}){
  if(options.help)throw new TypeError("help_does_not_query");
  if(options.knownAt>now.toISOString())throw new TypeError("future_knowledge_cutoff");
  if(options.demo){
    const fixture=syntheticFixture(options);
    const report=composeLocalTokenReport(options,fixture.evidence,fixture.timeline);
    return {...report,mode:"SYNTHETIC_FIXTURE_NO_DATABASE",syntheticFixture:true};
  }
  const connectionString=assertLocalDestination(env);
  const pool=makePool({
    connectionString,max:1,connectionTimeoutMillis:3000,
    query_timeout:6000,statement_timeout:5000,
    options:"-c default_transaction_read_only=on -c statement_timeout=5000",
  });
  let client,transaction=false;
  try{
    client=await pool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transaction=true;
    await checkApiReadiness(client);
    // Same transaction/snapshot for both read models, no source DB federation.
    const evidence=await queryTokenApi(client,parseQuery("evidence",options,now));
    const timeline=await queryTokenApi(client,parseQuery("timeline",options,now));
    const report=composeLocalTokenReport(options,evidence,timeline);
    await client.query("COMMIT");
    transaction=false;
    return {...report,syntheticFixture:false};
  }catch(error){
    if(client&&transaction){
      try{await client.query("ROLLBACK")}catch{/* preserve initial error */}
    }
    throw error;
  }finally{
    if(client)client.release();
    await pool.end();
  }
}
async function main(){
  let options;
  try{
    options=parseLocalTokenArgs(process.argv.slice(2));
    if(options.help){console.log(USAGE);return}
    const report=await makeLocalReport(options);
    console.log(options.json?JSON.stringify(report,null,2):formatLocalTokenReport(report));
  }catch(error){
    const msg=error instanceof Error&&
      /^(mint_required|canonical_solana_mint_required|invalid_|missing_or_duplicate_option|duplicate_option|unknown_option|future_or_inverted_window|future_knowledge_cutoff|limit_1_to_100|loopback_postgres_only|local_read_explicit_opt_in_required|local_postgres_required)/.test(error.message)
      ?error.message:"local_report_unavailable";
    // Never log PostgreSQL exceptions: they may contain DSNs or source payloads.
    console.error("Local token report failed: "+msg);
    process.exitCode=1;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  await main();
