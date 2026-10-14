import { createRequire } from "node:module";
import { assertXActionsRuntime } from "../src/xactions/runtime";

const loader = createRequire(__filename)("./xactions-http-loader.cjs") as {
  loadPinnedXActions(root: string): Promise<Record<string, unknown>>;
};

async function main(): Promise<void> {
  assertXActionsRuntime();
  const root = process.env.XACTIONS_ROOT;
  if (!root) throw new Error("XACTIONS_ROOT is required");
  const api = await loader.loadPinnedXActions(root);
  for (const name of ["TwitterHttpClient", "parseUserData", "parseTimelineInstructions",
    "userTimelineInstructions", "parseUserList"]) {
    if (typeof api[name] !== "function") throw new Error(`XActions pinned export missing: ${name}`);
  }
  const operations = api.GRAPHQL as Record<string, { queryId?: string; operationName?: string }> | undefined;
  for (const key of ["UserByScreenName", "UserTweets", "ListTimeline", "ListMembers"]) {
    const endpoint = operations?.[key];
    if (!endpoint?.queryId || !endpoint.operationName) {
      throw new Error(`XActions pinned GraphQL operation missing: ${key}`);
    }
  }
  const method = api.graphqlRequestMethod as ((name: string) => string) | undefined;
  if (typeof method !== "function" || method("SearchTimeline") !== "POST") {
    throw new Error("XActions: SearchTimeline diagnostic expects POST; do not enable HTTP search");
  }
  console.log("XActions pinned checkout, exports and SearchTimeline=POST verified offline. No X requests made.");
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "XActions local verification failed");
  process.exitCode = 1;
});
