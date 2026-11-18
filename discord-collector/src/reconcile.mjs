/**
 * Bounded restart gap reconciliation using authorized REST history. Deliberately
 * does NOT claim full channel coverage: edits/deletions during downtime cannot
 * be inferred from a limited window. A historical backfill is separate.
 */
const SNOWFLAKE=/^[0-9]{15,22}$/;

export async function scanRecentGap({channel,baselineMessageId,maxPages,onMessage}){
  if(!channel?.messages?.fetch || typeof onMessage!=="function")
    throw new TypeError("A readable authorized channel and onMessage callback are required");
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>50)
    throw new RangeError("Recovery page budget must be between 1 and 50");
  if(baselineMessageId!==null && (!SNOWFLAKE.test(String(baselineMessageId))))
    throw new TypeError("Invalid recovery baseline");
  let cursor=null;
  let pages=0;
  let processed=0;
  let reachedBaseline=false;
  let ranOutOfHistory=false;
  const floor=baselineMessageId===null?null:BigInt(baselineMessageId);
  for(let i=0;i<maxPages;i++){
    const batch=await channel.messages.fetch({limit:100,...(cursor?{before:cursor}:{})});
    pages++;
    if(batch.size===0){
      ranOutOfHistory=true;
      break;
    }
    const sorted=[...batch.values()].sort((a,b)=>{
      const aa=BigInt(a.id),bb=BigInt(b.id);
      return aa<bb?-1:aa>bb?1:0;
    });
    if(sorted.length===0)throw new Error("Provider page size/content mismatch");
    const oldest=String(sorted[0].id);
    if(!SNOWFLAKE.test(oldest))throw new Error("Invalid REST message ID");
    if(cursor!==null && BigInt(oldest)>=BigInt(cursor))
      throw new Error("Non-decreasing recovery page cursor");
    for(const message of sorted){
      const id=String(message.id);
      if(!SNOWFLAKE.test(id))throw new Error("Invalid REST message ID");
      if(floor!==null && BigInt(id)<=floor){
        reachedBaseline=true;
        continue;
      }
      await onMessage(message);
      processed++;
    }
    if(reachedBaseline)break;
    cursor=oldest;
    if(batch.size<100){
      ranOutOfHistory=true;
      break;
    }
  }
  let status;
  if(floor===null)status="initial_unverified";
  else if(reachedBaseline)status="bounded_recovery";
  else status="gap_unresolved";
  return {status,pagesScanned:pages,messagesProcessed:processed,
    ranOutOfHistory,reachedBaseline};
}
