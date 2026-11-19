function needsHydration(event){
  return event.kind!=="deleted"&&
    (!event.createdAt||(event.kind==="edited"&&(!event.editedAt||event.content===null)));
}

function unknownMessage(error){
  return error?.code===10008||error?.status===404||error?.rawError?.code===10008;
}

/**
 * Replay one encrypted ingress record. A record that needs REST hydration is
 * never acknowledged before Gateway readiness; transient REST failures are
 * thrown so the durable record remains queued. A definitive 404 is recorded
 * as an explicit coverage failure before the record may be acknowledged.
 */
export async function replaySpoolEntry({
  entry,allowHydration=true,authorized=true,hydrate,store,recordCoverageFailure,
}){
  if(!entry||!entry.event||typeof entry.sequence!=="string")
    throw new TypeError("Invalid durable ingress replay entry");
  if(typeof store!=="function"||typeof recordCoverageFailure!=="function")
    throw new TypeError("Replay persistence callbacks are required");
  if(!authorized)return {ack:true,status:"revoked"};
  const event=entry.event;
  const required=needsHydration(event);
  if(required&&!allowHydration)return {ack:false,status:"needs_hydration"};
  let message={
    id:event.messageId,guildId:event.guildId,channelId:event.channelId,
    author:event.authorId?{id:event.authorId}:null,content:event.content,
    createdAt:event.createdAt?new Date(event.createdAt):null,
    editedAt:event.editedAt?new Date(event.editedAt):null,
  };
  if(required){
    if(typeof hydrate!=="function")throw new TypeError("REST hydration callback is required");
    try{
      message=await hydrate(event);
    }catch(error){
      if(!unknownMessage(error))throw error;
      await recordCoverageFailure(event,"message_not_hydratable",entry.sequence);
      return {ack:true,status:"coverage_gap"};
    }
  }
  await store(message,event.kind,event);
  return {ack:true,status:"stored"};
}
