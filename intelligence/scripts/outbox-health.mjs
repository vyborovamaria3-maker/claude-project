const SQLITE_HEALTH_SQL = `SELECT
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS pending,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)) AS ready,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND lease_until>?) AS leased,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND attempts>0 AND next_attempt_at>?) AS retry_delayed,
  count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_letter,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND attempts>0) AS retry_events,
  coalesce(sum(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL),0) AS retry_attempts,
  min(created_at) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at,
  max(processed_at) AS last_progress_at,
  max(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS max_attempts
FROM outbox_events`;

const POSTGRES_HEALTH_SQL = `SELECT
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND next_attempt_at<=$1::timestamptz
    AND (lease_until IS NULL OR lease_until<=$1::timestamptz))::text AS ready,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND lease_until>$1::timestamptz)::text AS leased,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND attempts>0 AND next_attempt_at>$1::timestamptz)::text AS retry_delayed,
  count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead_letter,
  count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL
    AND attempts>0)::text AS retry_events,
  coalesce(sum(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL),0)::text AS retry_attempts,
  min(created_at) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS oldest_pending_at,
  max(processed_at) AS last_progress_at,
  coalesce(max(attempts) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL),0)::text AS max_attempts
FROM outbox_events`;

function count(value,name){
  const number=Number(value??0);
  if(!Number.isSafeInteger(number)||number<0)throw new TypeError("invalid outbox health count: "+name);
  return number;
}
function timestamp(value,name){
  if(value===null||value===undefined)return null;
  const date=value instanceof Date?value:new Date(String(value));
  if(!Number.isFinite(date.getTime()))throw new TypeError("invalid outbox health timestamp: "+name);
  return date.toISOString();
}
function ageMs(value,nowMs){
  if(value===null)return null;
  return Math.max(0,nowMs-Date.parse(value));
}

/** Read-only source outbox health; never selects payloads or changes leases. */
export async function readOutboxHealth(source,now=new Date()){
  if(!source||!["pg","sqlite"].includes(source.kind)||!source.connection||
     !(now instanceof Date)||!Number.isFinite(now.getTime())){
    throw new TypeError("invalid outbox health source/clock");
  }
  const at=now.toISOString();
  let row;
  if(source.kind==="sqlite"){
    row=source.connection.prepare(SQLITE_HEALTH_SQL).get(at,at,at,at);
  }else{
    const result=await source.connection.query(POSTGRES_HEALTH_SQL,[at]);
    row=result.rows?.[0];
  }
  if(!row)throw new Error("outbox health query returned no row");
  const oldestPendingAt=timestamp(row.oldest_pending_at,"oldest_pending_at");
  const lastProgressAt=timestamp(row.last_progress_at,"last_progress_at");
  const nowMs=now.getTime();
  return {
    observedAt:at,
    pending:count(row.pending,"pending"),
    ready:count(row.ready,"ready"),
    leased:count(row.leased,"leased"),
    retryDelayed:count(row.retry_delayed,"retry_delayed"),
    retryEvents:count(row.retry_events,"retry_events"),
    retryAttempts:count(row.retry_attempts,"retry_attempts"),
    deadLetter:count(row.dead_letter,"dead_letter"),
    maxAttempts:count(row.max_attempts,"max_attempts"),
    oldestPendingAt,
    oldestPendingAgeMs:ageMs(oldestPendingAt,nowMs),
    lastProgressAt,
    lastProgressAgeMs:ageMs(lastProgressAt,nowMs),
  };
}

/** Conservative local-log alerts; an external notification sink is separate. */
export function healthAlerts(health,thresholds={}){
  const pendingAgeWarnMs=thresholds.pendingAgeWarnMs??900_000;
  const deadLetterWarnCount=thresholds.deadLetterWarnCount??1;
  const retryEventsWarnCount=thresholds.retryEventsWarnCount??5;
  for(const [name,value,min,max] of [
    ["pendingAgeWarnMs",pendingAgeWarnMs,60_000,86_400_000],
    ["deadLetterWarnCount",deadLetterWarnCount,1,100_000],
    ["retryEventsWarnCount",retryEventsWarnCount,1,100_000],
  ]){
    if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError("invalid health threshold: "+name);
  }
  const alerts=[];
  if(health.deadLetter>=deadLetterWarnCount){
    alerts.push({code:"dead_letter_backlog",severity:"warning",count:health.deadLetter});
  }
  if(health.oldestPendingAgeMs!==null&&health.oldestPendingAgeMs>=pendingAgeWarnMs){
    alerts.push({code:"oldest_pending_age_exceeded",severity:"warning",
      ageMs:health.oldestPendingAgeMs,thresholdMs:pendingAgeWarnMs});
  }
  if(health.retryEvents>=retryEventsWarnCount){
    alerts.push({code:"retry_backlog",severity:"warning",
      count:health.retryEvents,thresholdCount:retryEventsWarnCount});
  }
  return alerts;
}
