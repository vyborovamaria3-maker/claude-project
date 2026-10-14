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
  // Exercise the ACTUAL pinned ESM HTTP client, not a mock replacement.
  // Only the injected fetch below can be called: it never touches the network.
  type Client = {
    graphql(id: string, operation: string, vars: Record<string, unknown>): Promise<{
      data?: Record<string, unknown>;
    }>;
  };
  const ClientCtor = api.TwitterHttpClient as new(opts: Record<string, unknown>) => Client;
  const requests: Array<{ operation: string; method: string; hasAuthCookie: boolean }> = [];
  const testFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const operation = url.pathname.split("/").pop() ?? "";
    const headers = new Headers(init?.headers);
    requests.push({
      operation, method: init?.method ?? "GET",
      hasAuthCookie: (headers.get("cookie") ?? "").includes("auth_token=offline-fixture"),
    });
    if (url.hostname !== "x.com" || !["UserByScreenName", "SearchTimeline"].includes(operation)) {
      throw new Error("XActions: unexpected outgoing request in offline test");
    }
    const data = operation === "UserByScreenName"
      ? { user: { result: { rest_id: "123", core: { screen_name: "offline_test", name: "Offline" } } } }
      : { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } };
    return new Response(JSON.stringify({ data }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const client = new ClientCtor({
    cookies: "auth_token=offline-fixture; ct0=offline-csrf",
    fetch: testFetch, autoRefreshQueryIds: false,
    transactionId: false, maxRetries: 0, rateLimitStrategy: "error",
  });
  const profile = operations?.UserByScreenName;
  const search = operations?.SearchTimeline;
  if (!profile?.queryId || !profile.operationName || !search?.queryId || !search.operationName) {
    throw new Error("XActions: missing offline smoke-test operations");
  }
  const response = await client.graphql(profile.queryId, profile.operationName, {
    screen_name: "offline_test", withSafetyModeUserFields: true,
  });
  const userResult = response.data?.user as { result?: { rest_id?: string } } | undefined;
  if (userResult?.result?.rest_id !== "123") throw new Error("XActions: fake UserByScreenName response not decoded");
  await client.graphql(search.queryId, search.operationName, {
    rawQuery: "offline_test", count: 1, querySource: "typed_query", product: "Latest",
  });
  if (requests.length !== 2 || requests[0]?.method !== "GET" || requests[1]?.method !== "POST"
    || requests[0]?.operation !== "UserByScreenName" || requests[1]?.operation !== "SearchTimeline"
    || requests.some(request => !request.hasAuthCookie)) {
    throw new Error("XActions: pinned HTTP client violated offline GET/POST/cookie contract");
  }
  // The pinned client converts custom fetch failures into NetworkError.
  // Guard this contract so our quota/lease restoration stays compatible.
  const rejecting = new ClientCtor({
    cookies: "auth_token=offline-fixture; ct0=offline-csrf",
    fetch: async () => { throw new Error("XACTIONS_QUOTA_EXHAUSTED"); },
    autoRefreshQueryIds: false, transactionId: false, maxRetries: 0,
  });
  let wrapped = false;
  try {
    await rejecting.graphql(profile.queryId, profile.operationName, { screen_name: "offline_test" });
  } catch (error) {
    wrapped = error instanceof Error &&
      error.name === "NetworkError" && error.message === "XACTIONS_QUOTA_EXHAUSTED";
  }
  if (!wrapped) throw new Error("XActions: upstream NetworkError wrapping contract has changed");
  console.log("XActions pinned checkout, HTTP GET/POST and wrapped quota error contracts verified offline. No X requests made.");
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "XActions local verification failed");
  process.exitCode = 1;
});
