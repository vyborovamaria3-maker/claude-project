import { setTimeout as sleep } from "node:timers/promises";

function count(stats, key) {
  const value=stats[key];
  if(!Number.isSafeInteger(value)||value<0)throw new TypeError("invalid batch counters");
  return value;
}

/**
 * Isolated, bounded local pump for one source. No source credentials,
 * event payloads or raw errors are sent to onReport.
 *
 * Cancellation never interrupts an in-flight destination transaction:
 * the caller stops future claims, awaits the active batch and then closes
 * connections. Each batch MUST claim exactly one event (lease renewal protects
 * that event, not queued members of a large claim batch).
 */
export async function runSourceLoop({
  source, runBatch, signal, pollMs=2000, paceMs=100,
  maxFailures=5, maxBatches=0, onReport=()=>{},
}) {
  if(!["x","tg","blockchain"].includes(source) ||
     !signal || typeof signal.aborted!=="boolean" ||
     typeof runBatch!=="function" || typeof onReport!=="function" ||
     !Number.isSafeInteger(pollMs) || pollMs<100 || pollMs>60_000 ||
     !Number.isSafeInteger(paceMs) || paceMs<0 || paceMs>60_000 ||
     !Number.isSafeInteger(maxFailures) || maxFailures<1 || maxFailures>100 ||
     !Number.isSafeInteger(maxBatches) || maxBatches<0 || maxBatches>1_000_000) {
    throw new RangeError("invalid supervisor options");
  }
  let failures=0, batches=0, idleRuns=0;
  const summary={source,batches:0,claimed:0,delivered:0,duplicates:0,failed:0,lostLeases:0};
  async function pause(ms) {
    if(signal.aborted)return;
    try {await sleep(ms,undefined,{signal})} catch(error){
      if(!signal.aborted)throw error;
    }
  }
  while(!signal.aborted && (!maxBatches || batches<maxBatches)){
    let delay=pollMs;
    try{
      const result=await runBatch();
      for(const field of ["claimed","delivered","duplicates","failed","lostLeases"]) {
        count(result,field);
      }
      if(result.claimed>1 || result.delivered+result.duplicates>result.claimed ||
         result.delivered+result.duplicates+result.failed>result.claimed+result.lostLeases){
        throw new TypeError("invalid batch accounting");
      }
      batches++;
      summary.batches=batches;
      for(const field of ["claimed","delivered","duplicates","failed","lostLeases"]){
        summary[field]+=result[field];
      }
      const bad=result.failed>0 || result.lostLeases>0;
      failures=bad ? failures+1 : 0;
      if(result.claimed>0 || bad){
        idleRuns=0;
        onReport({source,kind:"batch",...result,consecutiveFailures:failures});
      }else{
        idleRuns=Math.min(idleRuns+1,4);
      }
      if(failures>=maxFailures)throw new Error("failure_threshold_reached");
      if(result.claimed>0 && !bad)delay=paceMs;
      else delay=Math.min(pollMs*(2**idleRuns),15_000);
    }catch(error){
      if(error instanceof Error && error.message==="failure_threshold_reached")throw error;
      failures++;
      idleRuns=Math.min(idleRuns+1,4);
      onReport({source,kind:"error",code:"source_or_destination_operation_failed",
        consecutiveFailures:failures});
      if(failures>=maxFailures)throw new Error("failure_threshold_reached");
      delay=Math.min(pollMs*(2**idleRuns),15_000);
    }
    if(!signal.aborted && (!maxBatches || batches<maxBatches))await pause(delay);
  }
  return {...summary,stopped:signal.aborted};
}
