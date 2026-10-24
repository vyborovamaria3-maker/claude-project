import pg from 'pg';
import Database from 'better-sqlite3';
import {createAiGatewayFromEnv} from '@claude-project/ai-gateway';
import {registerModel} from '../dist/index.js';
import {requiredEnv} from './etl-connections.mjs';
import {analyzeTokenOnDemand} from './token-analysis.mjs';
export async function createTokenRequestRuntime(env=process.env){
 if(env.INTELLIGENCE_AI_ON_DEMAND_ENABLED!=='true')return null;
 const definitions=JSON.parse(requiredEnv('INTELLIGENCE_AI_MODELS_JSON',env));
 const model=definitions.find(m=>m.task==='explanation'&&m.modelId===env.INTELLIGENCE_AI_TOKEN_MODEL_ID);
 if(!model)throw new Error('token_ai_model_configuration_required');
 const gateway=createAiGatewayFromEnv(env,{maxAttempts:1});
 const resources=[];let chain;
 try{
  const destination=new pg.Pool({connectionString:requiredEnv('INTELLIGENCE_AI_DATABASE_URL',env),max:2,connectionTimeoutMillis:30000,statement_timeout:120000});resources.push(destination);
  const sources={};
  for(const name of ['x','tg']){
   const pool=new pg.Pool({connectionString:requiredEnv(name==='x'?'X_SOURCE_DATABASE_URL':'TG_SOURCE_DATABASE_URL',env),max:1,connectionTimeoutMillis:30000,statement_timeout:60000,query_timeout:65000,options:'-c default_transaction_read_only=on'});resources.push(pool);sources[name]=pool;
  }
  chain=new Database(requiredEnv('SOLANA_TRADE_DB_PATH',env),{readonly:true,fileMustExist:true,timeout:5000});sources.chain=chain;
  const ready=(await destination.query("SELECT to_regclass('token_ai_requests') IS NOT NULL AS ready")).rows[0]?.ready;
  if(!ready)throw new Error('token_ai_migration_016_required');
  await registerModel(destination,{...model,status:'active'});
  return {analyze:tokenId=>analyzeTokenOnDemand({destination,sources,gateway,modelId:model.modelId,tokenId}),
   close:async()=>{chain.close();await Promise.all(resources.map(pool=>pool.end()));}};
 }catch(error){chain?.close();await Promise.all(resources.map(pool=>pool.end()));throw error;}
}
