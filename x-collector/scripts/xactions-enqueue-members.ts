import { enqueueTask } from "../lib/trade/tasks";
import { MembersPayload } from "../lib/trade/schemas";
import { closePool } from "../lib/trade/pg";

async function main(): Promise<void> {
  if (process.env.COLLECTOR_ENGINE !== "xactions") {
    throw new Error("Set COLLECTOR_ENGINE=xactions to explicitly enqueue ListMembers tasks");
  }
  const [list_id, rawLimit] = process.argv.slice(2);
  if (!list_id) {
    throw new Error("Usage: npm run xactions:members -- <list_id> [limit]");
  }
  const payload = MembersPayload.parse({
    list_id, ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
  });
  const id = await enqueueTask({
    kind: "members", payload,
    // Every explicit run is a fresh observation of the list, not a permanent
    // duplicate of an earlier completed task.
    dedup: false,
  });
  console.log(JSON.stringify({ queuedTaskId: id, listId: payload.list_id, limit: payload.limit }));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Cannot enqueue members task");
  process.exitCode = 1;
}).finally(() => closePool());
