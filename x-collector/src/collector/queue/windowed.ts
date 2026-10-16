import { createHash } from "node:crypto";
import { q1 } from "../../../lib/trade/pg";
import { enqueueTask, type EnqueueParams } from "./tasks";

/** A source run is unique within an explicitly identified UTC time window. */
export interface WindowedTask extends Omit<EnqueueParams,"idempotencyKey"|"dedup"> {
  sourceKey: string;
  windowStart: number;
  windowEnd: number;
}
export function windowedTaskKey(input:WindowedTask):string {
  if(!input.sourceKey || input.sourceKey.length>300 ||
    !Number.isSafeInteger(input.windowStart) || input.windowStart<0 ||
    !Number.isSafeInteger(input.windowEnd) || input.windowEnd<=input.windowStart ||
    input.windowEnd-input.windowStart>31*86_400_000)throw new Error("Invalid collection window");
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):
    value && typeof value==="object"
      ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]))
      : value;
  const digest=createHash("sha256").update(JSON.stringify([
    input.kind,input.sourceKey,input.mint??null,input.handle?.toLowerCase()??null,
    input.windowStart,input.windowEnd,canonical(input.payload),
  ])).digest("hex");
  return "window:"+digest;
}
/**
 * The underlying enqueueTask returns null on idempotency conflict. A caller of
 * the windowed API instead gets the already-existing task ID, not a duplicate.
 */
export async function enqueueWindowedTask(input:WindowedTask):Promise<number> {
  const key=windowedTaskKey(input);
  const id=await enqueueTask({...input,idempotencyKey:key});
  if(id!==null)return id;
  const row=await q1<{id:string}>("SELECT id::text AS id FROM x_tasks WHERE idempotency_key=$1",[key]);
  if(!row)throw new Error("Collection window conflict could not be resolved");
  const found=Number(row.id);
  if(!Number.isSafeInteger(found)||found<1)throw new Error("Invalid existing collection task");
  return found;
}
