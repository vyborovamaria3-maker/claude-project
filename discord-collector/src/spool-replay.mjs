/**
 * Replay a bounded page in source order. An event is ACKed only when its
 * processor explicitly reports that it is safe to discard the encrypted
 * ingress record. A deferred hydration blocks later records to preserve order.
 */
export async function replaySpoolEntries({
  entries,processEntry,acknowledge,flushAcks,shouldContinue=()=>true,
}){
  if(!Array.isArray(entries))throw new TypeError("Replay entries must be an array");
  if(typeof processEntry!=="function"||typeof acknowledge!=="function"||
     typeof flushAcks!=="function"||typeof shouldContinue!=="function")
    throw new TypeError("Replay callbacks are required");
  let acknowledged=0;
  let blockedSequence=null;
  try{
    for(const entry of entries){
      if(!shouldContinue())break;
      const result=await processEntry(entry);
      if(!result||typeof result.ack!=="boolean")
        throw new TypeError("Replay processor must explicitly return an ACK decision");
      if(!result.ack){
        blockedSequence=String(entry.sequence);
        break;
      }
      await acknowledge(entry.sequence);
      acknowledged++;
    }
  }finally{
    // Flush any ACKs already issued even when a later event fails.
    await flushAcks();
  }
  return {acknowledged,blocked:blockSequenceIsSet(blockedSequence),blockedSequence};
}
function blockSequenceIsSet(value){return value!==null;}
