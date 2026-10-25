#!/usr/bin/env node
import "node:process";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import pg from "pg";
import {createTokenRequestRuntime} from "../scripts/token-request-runtime.mjs";
import {API_HOST,createIntelligenceApi,checkApiReadiness,checkAiReadiness,checkCrossPlatformReadiness,validateApiToken} from "./server.mjs";

export function apiConfiguration(env=process.env){
  if(env.INTELLIGENCE_API_ENABLED!=="true")
    throw new Error("api_explicit_opt_in_required");
  const token=validateApiToken(env.INTELLIGENCE_API_TOKEN);
  const connectionString=env.INTELLIGENCE_DATABASE_URL;
  if(typeof connectionString!=="string"||!connectionString.trim())
    throw new Error("intelligence_database_config_required");
  const rawPort=env.INTELLIGENCE_API_PORT??"3182";
  if(!/^[1-9][0-9]*$/.test(rawPort)||Number(rawPort)>65535)
    throw new Error("invalid_api_port");
  const crossFlag=env.INTELLIGENCE_CROSS_PLATFORM_ENABLED??"false";
  if(!["true","false"].includes(crossFlag))throw new Error("invalid_cross_platform_opt_in");
  const crossPlatformEnabled=crossFlag==="true";
  const aiFlag=env.INTELLIGENCE_AI_API_ENABLED??"false";
  if(aiFlag!=="true"&&aiFlag!=="false")throw new Error("invalid_ai_api_opt_in");
  const aiEnabled=aiFlag==="true";
  const aiToken=aiEnabled?validateApiToken(env.INTELLIGENCE_AI_API_TOKEN):undefined;
  if(aiEnabled&&aiToken===token)throw new Error("ai_api_token_must_be_distinct");
  return {token,connectionString,port:Number(rawPort),
    ...(aiEnabled?{aiEnabled:true,aiToken}:{}),
    ...(crossPlatformEnabled?{crossPlatformEnabled:true}:{})};
}
export async function startLocalIntelligenceApi(env=process.env){
  const config=apiConfiguration(env);
  // The separate Intelligence DB connection is read-only at the PostgreSQL
  // session level. Production still requires an independently scoped SELECT
  // database role, so a leaked token cannot grant source/collector access.
  const pool=new pg.Pool({
    connectionString:config.connectionString,max:4,
    connectionTimeoutMillis:3000,query_timeout:6000,
    statement_timeout:5000,
    options:"-c default_transaction_read_only=on -c statement_timeout=5000",
  });
  let server,tokenRuntime;
  try{
    await checkApiReadiness(pool);
    if(config.aiEnabled)await checkAiReadiness(pool);
    if(config.crossPlatformEnabled)await checkCrossPlatformReadiness(pool);
    tokenRuntime=await createTokenRequestRuntime(env);
    server=createIntelligenceApi({token:config.token,pool,aiEnabled:config.aiEnabled??false,
      aiToken:config.aiToken,crossPlatformEnabled:config.crossPlatformEnabled,
      analyzeToken:tokenRuntime?.analyze});
    if(tokenRuntime)server.once("close",()=>{void tokenRuntime.close();});
    const api=server;
    await new Promise((accept,reject)=>{
      api.once("error",reject);
      api.listen(config.port,API_HOST,()=>{
        api.off("error",reject);accept();
      });
    });
    const shutdown=()=>{
      api.close(()=>{void pool.end();});
    };
    process.once("SIGINT",shutdown);
    process.once("SIGTERM",shutdown);
    return {server:api,pool,address:API_HOST,port:config.port};
  }catch(error){
    if(server)server.close();else if(tokenRuntime)await tokenRuntime.close();
    await pool.end();
    throw error;
  }
}
async function main(){
  await startLocalIntelligenceApi();
  console.log("Intelligence API v1 listening on local loopback");
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(()=>{
    // Neither the original PostgreSQL/HTTP exception nor the token is logged.
    console.error("Intelligence API failed: configuration_or_database_unavailable");
    process.exitCode=1;
  });
}
