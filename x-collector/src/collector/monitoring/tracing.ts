import { q } from "../../../lib/trade/pg";
export const TASK_STAGES = [
  "selecting","opening","collecting","saving","waiting",
  "unverified_end","finishing","failed","checkpoint",
] as const;
export type TaskStage=typeof TASK_STAGES[number];
export interface TaskTraceRow {
  id:string;stage:TaskStage;worker_id:string;attempt:number;
  account_name:string|null;observed_count:number|null;created_at:string;
}
/** Allowed metadata is deliberately restricted to numeric counts and account name. */
export async function traceTaskStage(
  taskId:number,workerId:string,attempt:number,stage:TaskStage,
  info:{accountName?:string|null;observedCount?:number}={},
):Promise<boolean> {
  if(!Number.isSafeInteger(taskId)||taskId<1||
    !Number.isSafeInteger(attempt)||attempt<0||attempt>100||
    !workerId||workerId.length>200||!TASK_STAGES.includes(stage)||
    (info.observedCount!==undefined&&(!Number.isSafeInteger(info.observedCount)||info.observedCount<0)))
    throw new Error("Invalid task trace");
  const rows=await q(`INSERT INTO xc_task_events
     (task_id,worker_id,attempt,stage,account_name,observed_count,created_at)
    SELECT id,$2,$3,$4,$5,$6,$7 FROM x_tasks WHERE id=$1
     AND claimed_by=$2 AND attempts=$3 AND status='claimed' AND lease_expires_at>$7
    RETURNING id`,
    [taskId,workerId,attempt,stage,info.accountName??null,info.observedCount??null,Date.now()]);
  return rows.length===1;
}
export async function taskTrace(taskId:number,limit=100):Promise<TaskTraceRow[]> {
  if(!Number.isSafeInteger(taskId)||taskId<1||
     !Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error("Invalid trace request");
  return q<TaskTraceRow>(`SELECT id::text,stage,worker_id,attempt,account_name,
    observed_count,created_at::text FROM xc_task_events
    WHERE task_id=$1 ORDER BY id DESC LIMIT $2`,[taskId,limit]);
}
