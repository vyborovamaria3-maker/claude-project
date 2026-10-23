import {randomUUID} from "node:crypto";
type DbPool=Readonly<{connect:()=>Promise<{query:(sql:string,params?:readonly unknown[])=>Promise<{rows:any[]}>;release:()=>void}>}>;
const MAX_USD=100_000;
function usd(value:number):number{
  if(!Number.isFinite(value)||value<=0||value>MAX_USD)throw new TypeError("invalid_ai_budget_amount");
  return Number(value.toFixed(8)) || 0.00000001;
}
function providerId(value:string):string {
  if(typeof value!=="string"||!/^[A-Za-z0-9._-]{1,64}$/.test(value))
    throw new TypeError("invalid_ai_budget_provider");
  return value;
}
async function transaction<T>(pool:DbPool,callback:(tx:Awaited<ReturnType<DbPool["connect"]>>)=>Promise<T>):Promise<T> {
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");
    try{const result=await callback(tx);await tx.query("COMMIT");return result;}
    catch(e){try{await tx.query("ROLLBACK")}catch{}throw e;}
  }finally{tx.release();}
}
/** Atomic across workers/processes: checked UPDATE locks the daily provider row. */
export async function reserveSharedAiBudget(pool:DbPool,input:Readonly<{
  providerId:string;dailyLimitUsd:number;reservationUsd:number;
}>):Promise<string>{
  const provider=providerId(input.providerId);
  const daily=usd(input.dailyLimitUsd),allowance=usd(input.reservationUsd);
  if(allowance>daily)throw new Error("shared_ai_budget_exceeded");
  const id=randomUUID();
  return transaction(pool,async tx=>{
    const clock=await tx.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day");
    const day=String(clock.rows[0]?.day??"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("shared_ai_budget_clock_unavailable");
    await tx.query(`INSERT INTO ai_daily_budgets(provider_id,budget_day,limit_usd)
      VALUES($1,$2,$3) ON CONFLICT(provider_id,budget_day) DO NOTHING`,[provider,day,daily]);
    const updated=await tx.query(`UPDATE ai_daily_budgets SET reserved_allowance_usd=reserved_allowance_usd+$3
      WHERE provider_id=$1 AND budget_day=$2 AND limit_usd=$4
        AND used_allowance_usd+reserved_allowance_usd+$3<=limit_usd
      RETURNING provider_id`,[provider,day,allowance,daily]);
    if(updated.rows.length!==1)throw new Error("shared_ai_budget_exceeded_or_changed");
    await tx.query(`INSERT INTO ai_budget_reservations
      (reservation_id,provider_id,budget_day,allowance_usd)
      VALUES($1,$2,$3,$4)`,[id,provider,day,allowance]);
    return id;
  });
}
/** Conservative settlement: charge the whole reserved allowance even if
 * usage is unknown or the provider call fails. Reconciliation may update
 * invoices separately; never refund an uncertain remote API failure. */
export async function settleSharedAiBudget(pool:DbPool,input:Readonly<{
  reservationId:string;measuredCostUsd?:number|null;
}>):Promise<boolean>{
  if(typeof input.reservationId!=="string"||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.reservationId))
    throw new TypeError("invalid_ai_budget_reservation");
  if(input.measuredCostUsd!==null&&input.measuredCostUsd!==undefined&&
     (!Number.isFinite(input.measuredCostUsd)||input.measuredCostUsd<0||input.measuredCostUsd>MAX_USD))
    throw new TypeError("invalid_ai_budget_observed_cost");
  return transaction(pool,async tx=>{
    const result=await tx.query(`SELECT provider_id,budget_day,allowance_usd,status
      FROM ai_budget_reservations WHERE reservation_id=$1 FOR UPDATE`,[input.reservationId]);
    const row=result.rows[0];
    if(!row)throw new Error("shared_ai_reservation_missing");
    if(row.status==="settled")return false;
    if(row.status!=="reserved")throw new Error("shared_ai_reservation_invalid");
    await tx.query(`UPDATE ai_daily_budgets
      SET reserved_allowance_usd=reserved_allowance_usd-$3,
        used_allowance_usd=used_allowance_usd+$3
      WHERE provider_id=$1 AND budget_day=$2`,[
      row.provider_id,row.budget_day,row.allowance_usd,
    ]);
    await tx.query(`UPDATE ai_budget_reservations
      SET status='settled',settled_at=clock_timestamp(),measured_cost_usd=$2
      WHERE reservation_id=$1`,[input.reservationId,input.measuredCostUsd??null]);
    return true;
  });
}
