import { safeLastErrorCode } from "./task-status";

export interface TaskErrorRow { status:string; kind:string; code:string; tasks:number; }

/** Reject untrusted historical error-tag contents, then coalesce bucket counts. */
export function collapseErrorTags(rows:TaskErrorRow[]):TaskErrorRow[] {
  const grouped = new Map<string,TaskErrorRow>();
  for (const row of rows) {
    const code = safeLastErrorCode("[" + row.code + "]") ?? "LEGACY_OR_UNKNOWN";
    const key = JSON.stringify([row.status,row.kind,code]);
    const previous = grouped.get(key);
    if (previous) previous.tasks += Number(row.tasks);
    else grouped.set(key,{status:row.status,kind:row.kind,code,tasks:Number(row.tasks)});
  }
  return [...grouped.values()].sort((a,b)=>b.tasks-a.tasks || a.code.localeCompare(b.code));
}
