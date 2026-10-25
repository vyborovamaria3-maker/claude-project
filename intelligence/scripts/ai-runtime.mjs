import {createAiGatewayFromEnv} from "@claude-project/ai-gateway";
import {readCollectorMessage,readCollectorContext,runAiAnalysisBatch,registerModel,refreshTokenDailyCrossPlatform,parseSnapshotEncryptionKey,readEncryptedEventText,reserveSharedAiBudget,settleSharedAiBudget} from "../dist/index.js";

/** One shared budget policy for background and explicit on-demand calls. */
export function createBudgetedAiGateway(destination,env=process.env){
  const gateway=createAiGatewayFromEnv(env,{maxAttempts:1});
  const sharedMode=env.INTELLIGENCE_AI_SHARED_BUDGET_ENABLED==="true";
  const dailyLimit=Number(env.INTELLIGENCE_AI_SHARED_DAILY_BUDGET_USD);
  const configured=sharedMode?JSON.parse(env.AI_PROVIDERS_JSON??"[]"):[];
  if(sharedMode&&(!Number.isFinite(dailyLimit)||dailyLimit<=0||dailyLimit>100_000||
     !Array.isArray(configured)||!configured.length||
     configured.some(item=>!item||typeof item.id!=="string"||
       !Number.isFinite(item.inputCostPer1kUsd)||item.inputCostPer1kUsd<0||
       !Number.isFinite(item.outputCostPer1kUsd)||item.outputCostPer1kUsd<0)))
    throw new Error("ai_shared_budget_configuration_invalid");
  const prices=new Map(configured.map(item=>[item.id,item]));
  const reservationCost=(provider,request,task)=>{
    const config=prices.get(provider);
    if(!config)throw new Error("ai_shared_budget_unknown_provider");
    // Conservative upper-bound proxy: UTF-8 bytes rather than chars/4,
    // plus protocol overhead, and the configured maximum output tokens.
    const bytes=task==="chat"?Buffer.byteLength(JSON.stringify(request.messages),"utf8"):
      Buffer.byteLength(JSON.stringify(request.texts),"utf8");
    const inputTokensUpper=bytes+8192;
    const outputTokensUpper=task==="chat"?Number(request.maxTokens??Math.min(1000,config.maxOutputTokens??2000)):0;
    if(!Number.isSafeInteger(outputTokensUpper)||outputTokensUpper<0||
       outputTokensUpper>Number(config.maxOutputTokens??8192))
      throw new Error("ai_shared_budget_output_bound_invalid");
    return Math.max(0.00000001,(inputTokensUpper*config.inputCostPer1kUsd+
      outputTokensUpper*config.outputCostPer1kUsd)/1000);
  };
  const budgetGateway=sharedMode?{
    ...gateway,
    async chatCompletion(request){
      const provider=request.providerId??env.AI_DEFAULT_PROVIDER;
      const id=await reserveSharedAiBudget(destination,{providerId:provider,
        dailyLimitUsd:dailyLimit,reservationUsd:reservationCost(provider,request,"chat")});
      let cost=null;
      try{
        const result=await gateway.chatCompletion(request);
        cost=result.estimatedCostUsd;
        return result;
      }finally{
        // Unknown/failed remote requests retain their full allowance so that
        // a billing uncertainty can never unlock additional API requests.
        await settleSharedAiBudget(destination,{reservationId:id,measuredCostUsd:cost});
      }
    },
    async createEmbeddings(request){
      const provider=request.providerId??env.AI_DEFAULT_PROVIDER;
      const id=await reserveSharedAiBudget(destination,{providerId:provider,
        dailyLimitUsd:dailyLimit,reservationUsd:reservationCost(provider,request,"embedding")});
      let cost=null;
      try{
        const result=await gateway.createEmbeddings(request);
        cost=result.estimatedCostUsd;return result;
      }finally{
        await settleSharedAiBudget(destination,{reservationId:id,measuredCostUsd:cost});
      }
    },
  }:gateway;
  return budgetGateway;
}

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
  const snapshotMode=env.INTELLIGENCE_AI_TEXT_SNAPSHOTS_ENABLED==="true";
  const snapshotKey=snapshotMode?parseSnapshotEncryptionKey(env.INTELLIGENCE_TEXT_ENCRYPTION_KEY_B64):null;
  const snapshotKeyRef=snapshotMode?env.INTELLIGENCE_TEXT_KEY_REF:null;
  if(snapshotMode&&(!snapshotKeyRef||!/^[a-zA-Z0-9._:-]{1,128}$/.test(snapshotKeyRef)))
    throw new Error("ai_snapshot_key_ref_required");
  const budgetGateway=createBudgetedAiGateway(destination,env);
  const sharedMode=env.INTELLIGENCE_AI_SHARED_BUDGET_ENABLED==="true";
  const client=await destination.connect();
  try{
    const tables=await client.query("SELECT to_regclass('ai_message_analyses') IS NOT NULL AS ready, to_regclass('ai_cost_ledger') IS NOT NULL AS ledger_ready");
    if(!tables.rows[0]?.ready)throw new Error("ai_migration_009_required");
    if(!tables.rows[0]?.ledger_ready)throw new Error("ai_migration_010_required");
    if(sharedMode){
      const ready=await client.query("SELECT to_regclass('ai_daily_budgets') IS NOT NULL AS ready");
      if(ready.rows[0]?.ready!==true)throw new Error("ai_migration_012_required");
    }
    for(const def of definitions){
      await registerModel(client,{...def,status:"active"});
      const active=await client.query("SELECT status FROM model_registry WHERE model_id=$1",[def.modelId]);
      if(active.rows[0]?.status!=="active")throw new Error("ai_model_not_active");
    }
  }finally{client.release();}
  return {
    async run(source,signal){
      if(!["x","tg"].includes(source))return null;
      const connection=sources?.[source];
      if(!snapshotMode&&!connection)return null;
      return runAiAnalysisBatch({destination,source,gateway:budgetGateway,models,limit,signal,
        readText:async(ref,at,kind,eventKey)=>{
          if(!snapshotMode)return readCollectorMessage(connection,source,ref,at);
          if(!kind||!eventKey)throw new Error("ai_snapshot_identity_required");
          const tx=await destination.connect();
          try{
            return await readEncryptedEventText(tx,snapshotKey,{sourceSystem:source,
              sourceEventKind:kind,eventKey,keyRef:snapshotKeyRef});
          }finally{tx.release();}
        },
        readContext:snapshotMode?undefined:(ref,at)=>readCollectorContext(connection,source,ref,at),
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
