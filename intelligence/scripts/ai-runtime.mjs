import {createAiGatewayFromEnv} from "@claude-project/ai-gateway";
import {readCollectorMessage,readCollectorContext,runAiAnalysisBatch,registerModel,refreshTokenDailyCrossPlatform} from "../dist/index.js";

/** Explicit API opt-in, separate from collector ACK/lease handling. */
export async function createAiRuntime(destination,sources,env=process.env){
  if(env.INTELLIGENCE_AI_ENABLED!=="true")return null;
  const definitions=JSON.parse(env.INTELLIGENCE_AI_MODELS_JSON??"[]");
  if(!Array.isArray(definitions)||!definitions.length||definitions.length>3)throw new Error("ai_models_required");
  const models={};
  for(const def of definitions){
    if(!def||!["sentiment","narrative","explanation"].includes(def.task)||models[def.task])throw new Error("invalid_ai_models");
    models[def.task]=def.modelId;
  }
  const limit=Number(env.INTELLIGENCE_AI_BATCH_SIZE??"2");
  if(!Number.isSafeInteger(limit)||limit<1||limit>8)throw new Error("invalid_ai_batch_size");
  const gateway=createAiGatewayFromEnv(env,{maxAttempts:1});
  const client=await destination.connect();
  try{
    const tables=await client.query("SELECT to_regclass('ai_message_analyses') IS NOT NULL AS ready");
    if(!tables.rows[0]?.ready)throw new Error("ai_migration_009_required");
    for(const def of definitions){
      await registerModel(client,{...def,status:"active"});
      const active=await client.query("SELECT status FROM model_registry WHERE model_id=$1",[def.modelId]);
      if(active.rows[0]?.status!=="active")throw new Error("ai_model_not_active");
    }
  }finally{client.release();}
  return {
    async run(source,signal){
      const connection=sources[source];
      if(!["x","tg"].includes(source)||!connection)return null;
      return runAiAnalysisBatch({destination,source,gateway,models,limit,signal,
        readText:(ref,at)=>readCollectorMessage(connection,source,ref,at),
        readContext:(ref,at)=>readCollectorContext(connection,source,ref,at),
        refresh:async(token,day)=>{
          const tx=await destination.connect();
          try{
            await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
            await refreshTokenDailyCrossPlatform(tx,token,day,new Date());
            await tx.query("COMMIT");
          }catch(error){try{await tx.query("ROLLBACK");}catch{}throw error;}
          finally{tx.release();}
        },
      });
    },
  };
}
