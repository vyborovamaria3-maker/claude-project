import { q } from "../../../lib/trade/pg";
import type { BrowserCoverage } from "../persistence/browser-checkpoint";

export interface BrowserQualityRow {
  coverage:BrowserCoverage;tasks:number;committed_task_links:string;
}
/**
 * Observational dashboard only: target_reached is not a verified X end marker.
 * Numbers count task-post links, not unique globally published X posts.
 */
export async function collectorQualitySnapshot(now=Date.now(),windowHours=24) {
  if(!Number.isSafeInteger(now)||now<0||
    !Number.isSafeInteger(windowHours)||windowHours<1||windowHours>720)
    throw new Error("Invalid collector quality window");
  const since=now-windowHours*3600_000;
  const [coverage,failed,queue]=await Promise.all([
    q<BrowserQualityRow>(`SELECT coverage,count(*)::int AS tasks,
      coalesce(sum(observed_count),0)::text AS committed_task_links
      FROM xc_browser_checkpoints WHERE updated_at>=$1
      GROUP BY coverage ORDER BY coverage`,[since]),
    q<{kind:string;count:number}>(`SELECT kind,count(*)::int AS count FROM x_tasks
      WHERE status='failed' AND updated_at>=$1 GROUP BY kind ORDER BY kind`,[since]),
    q<{status:string;count:number}>(`SELECT status,count(*)::int AS count FROM x_tasks
      GROUP BY status ORDER BY status`),
  ]);
  const observedTasks=coverage.reduce((sum,row)=>sum+Number(row.tasks),0);
  return {
    observedAt:new Date(now).toISOString(),windowHours,observedTasks,
    browserCoverage:coverage,failedByKind:failed,queue,
    note:"Browser end-of-feed is not verified by a target count; committed_task_links count saved task links, not global unique posts.",
  };
}
