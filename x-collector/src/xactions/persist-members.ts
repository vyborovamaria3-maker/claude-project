import type { AccountProfileData } from "../../lib/trade/twitter-scraper";
import { persistProfile } from "../../lib/trade/collector-store";
import { commitHttpPage, type HttpCheckpointKey, type HttpLease } from "./checkpoint-store";
import type { PageCommit } from "./pagination";

export interface MemberPageContext extends HttpCheckpointKey {
  lease: HttpLease;
  previousCursor: string | null;
}

/**
 * Keep list-membership observations, profile upserts and opaque pagination
 * progress in ONE transaction. Member links are observed, never asserted to
 * represent a complete list. On rollback, no progress or membership survives.
 */
export async function persistXActionsMemberPage(
  context: MemberPageContext,
  page: PageCommit<AccountProfileData>,
): Promise<number> {
  let newItems = 0;
  if (context.sourceKind !== "members") throw new Error("XActions: invalid member source kind");
  if (!/^[0-9]{1,25}$/.test(context.sourceKey)) throw new Error("XActions: invalid list ID");
  const byHandle = new Map<string, AccountProfileData>();
  for (const profile of page.items) byHandle.set(profile.handle.toLowerCase(), profile);
  const entries = [...byHandle.values()];
  if (entries.length > 200) throw new Error("XActions: member page exceeds safety limit");
  await commitHttpPage({
    ...context,
    expectedCursor: context.previousCursor,
    nextCursor: page.nextCursor,
    completed: page.completed,
    itemsWritten: entries.length,
  }, async client => {
    let insertedProfiles = 0;
    for (const profile of entries) {
      insertedProfiles += await persistProfile(profile, context.taskId, context.lease.accountName, {
        workerId: context.lease.workerId,
        attempt: context.lease.attempt,
        accountName: context.lease.accountName,
        accountOwner: context.lease.accountOwner,
      }, { client, transport: "http" });
      await client.query(
        `INSERT INTO xc_list_member_observations(list_id,handle,first_seen_at,last_seen_at,last_task_id)
         VALUES ($1,$2,$3,$3,$4)
         ON CONFLICT(list_id,handle) DO UPDATE
           SET last_seen_at=EXCLUDED.last_seen_at,last_task_id=EXCLUDED.last_task_id`,
        [context.sourceKey, profile.handle.toLowerCase(), Date.now(), context.taskId],
      );
    }
    newItems = insertedProfiles;
    return newItems;
  });
  return newItems;
}
