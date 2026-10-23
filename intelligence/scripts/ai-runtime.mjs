import {createAiGatewayFromEnv} from "@claude-project/ai-gateway";
import {readCollectorMessage,readCollectorContext,runAiAnalysisBatch,registerModel,refreshTokenDailyCrossPlatform,parseSnapshotEncryptionKey,readEncryptedEventText} from "../dist/index.js";

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
  const gateway=createAiGatewayFromEnv(env,{maxAttempts:1});
  const client=await destination.connect();
  try{
    const tables=await client.query("SELECT to_regclass('ai_message_analyses') IS NOT NULL AS ready, to_regclass('ai_cost_ledger') IS NOT NULL AS ledger_ready");
    if(!tables.rows[0]?.ready)throw new Error("ai_migration_009_required");
    if(!tables.rows[0]?.ledger_ready)throw new Error("ai_migration_010_required");
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
      return runAiAnalysisBatch({destination,source,gateway,models,limit,signal,
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
