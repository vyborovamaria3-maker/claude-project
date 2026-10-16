import test from "node:test";
import assert from "node:assert/strict";
import { XActionsReadEngine, verifyHttpPageEnd, normalizeTimelineInstructions, isSearchCursorOnlyEnd, type ReadClient, type ReadParsers } from "../src/xactions/engine";

const validTweet = {
  id: "1878727153048777016", text: "hello", author: { username: "NASA" },
  metrics: { likes: 10 }, createdAt: "2026-10-12T00:00:00.000Z",
};

test("only the measured top/bottom cursor-only search response ends a search", () => {
  const pair = ["Top", "Bottom"].map(cursorType => ({ type: "TimelineReplaceEntry",
    entry: { content: { __typename: "TimelineTimelineCursor", cursorType, value: "opaque" } } }));
  assert.equal(isSearchCursorOnlyEnd(pair, 0), true);
  assert.equal(isSearchCursorOnlyEnd(pair, 1), false);
  assert.equal(isSearchCursorOnlyEnd([pair[0]], 0), false);
  assert.equal(isSearchCursorOnlyEnd([pair[0], pair[0]], 0), false);
  assert.equal(isSearchCursorOnlyEnd([...pair, { type: "TimelineAddEntries", entries: [] }], 0), false);
});

test("live replacement cursors reach the pinned SDK without losing add-entry data", () => {
  const first = { type: "TimelineAddEntries", entries: [{ entryId: "tweet-1" }] };
  const bottom = { content: { __typename: "TimelineTimelineCursor", cursorType: "Bottom", value: "opaque-next" } };
  const terminal = { type: "TimelineTerminateTimeline" };
  assert.deepEqual(normalizeTimelineInstructions([first,
    { type: "TimelineReplaceEntry", entry_id_to_replace: "cursor-bottom-old", entry: bottom }, terminal]),
  [first, { type: "TimelineAddEntries", entries: [{ ...bottom, entryId: "cursor-bottom-old" }] }, terminal]);
  assert.deepEqual(normalizeTimelineInstructions([{ type: "TimelineReplaceEntry" }]), [{ type: "TimelineReplaceEntry" }]);
});

const endpoints = {
  userByScreenName: { queryId: "a", operationName: "UserByScreenName" },
  userTweets: { queryId: "b", operationName: "UserTweets" },
  listTimeline: { queryId: "c", operationName: "ListLatestTweetsTimeline" },
};
const parsers: ReadParsers = {
  parseUserData: () => ({ username: "NASA", name: "NASA", followers: 20 }),
  parseTimelineInstructions: () => ({ tweets: [validTweet], cursor: "cursor-2" }),
  userTimelineInstructions: () => [],
};

test("HTTP read engine can normalize a profile from an injected XActions parser", async () => {
  const client: ReadClient = { graphql: async () => ({ data: { user: { result: { rest_id: "123" } } } }) };
  const engine = new XActionsReadEngine(client, endpoints, parsers);
  assert.equal((await engine.profile("NASA")).followers, 20);
  assert.equal(await engine.resolveUserId("NASA"), "123");
});

test("HTTP read engine sends cursor only when provided for list timeline", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client: ReadClient = { graphql: async (_id, op, variables) => {
    assert.equal(op, "ListLatestTweetsTimeline");
    requests.push(variables);
    return { data: { list: { tweets_timeline: { timeline: { instructions: [] } } } } };
  } };
  const engine = new XActionsReadEngine(client, endpoints, parsers);
  const page = await engine.listPage("1945268064792068152", "opaque");
  assert.equal(requests[0]?.cursor, "opaque");
  assert.equal(page.nextCursor, "cursor-2");
  assert.equal(page.items[0]?.id, validTweet.id);
});

\ntest("tweet pages retain the GraphQL envelope and request cursor for replay", async () => {\n  const response = {\n    data: { list: { tweets_timeline: { timeline: { instructions: [] } } } },\n    errors: [],\n  };\n  const variables = { listId: "1945268064792068152", count: 20, cursor: "opaque-page-2" };\n  const client: ReadClient = { graphql: async (_id, operation, requestVariables) => {\n    assert.equal(operation, "ListLatestTweetsTimeline");\n    assert.deepEqual(requestVariables, variables);\n    return response;\n  } };\n  const engine = new XActionsReadEngine(client, endpoints, parsers);\n  const page = await engine.listPage(variables.listId, variables.cursor);\n  assert.deepEqual(page.rawResponse, {\n    endpoint: "ListLatestTweetsTimeline",\n    queryId: "c",\n    variables,\n    response,\n  });\n});\ntest("malformed list response must fail instead of silently marking complete", async () => {
  const client: ReadClient = { graphql: async () => ({ data: { list: {} } }) };
  const engine = new XActionsReadEngine(client, endpoints, parsers);
  await assert.rejects(engine.listPage("1945268064792068152"), /response shape changed/);
});

test("malformed user timeline response must fail instead of silently claiming completion", async () => {
  const client: ReadClient = { graphql: async () => ({ data: { user: { result: {} } } }) };
  const engine = new XActionsReadEngine(client, endpoints, parsers);
  await assert.rejects(engine.timelinePage("123456"), /response shape changed/);
});

test("ListMembers page returns profiles and preserves a real opaque cursor", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: ReadClient = { graphql: async (_id, op, variables) => {
    assert.equal(op, "ListMembers");
    calls.push(variables);
    return { data: { list: { members_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries" }] } } } } };
  } };
  const engine = new XActionsReadEngine(client, {
    ...endpoints, listMembers: { queryId: "m", operationName: "ListMembers" },
  }, {
    ...parsers,
    parseUserList: () => ({ users: [{ username: "NASA", name: "NASA", followersCount: 123 }], cursor: "member-cursor-2" }),
  });
  const page = await engine.listMembersPage("1878727153048777016", "member-cursor-1");
  assert.equal(calls[0]?.cursor, "member-cursor-1");
  assert.equal(page.nextCursor, "member-cursor-2");
  assert.deepEqual(page.items.map(p => p.handle), ["NASA"]);
  assert.equal(page.items[0]?.followers, 123);
});

test("ListMembers invalid response is an error, not a complete list", async () => {
  const client: ReadClient = { graphql: async () => ({ data: { list: {} } }) };
  const engine = new XActionsReadEngine(client, {
    ...endpoints, listMembers: { queryId: "m", operationName: "ListMembers" },
  }, { ...parsers, parseUserList: () => ({ users: [], cursor: null }) });
  await assert.rejects(engine.listMembersPage("1878727153048777016"), /response shape changed/);
});

test("diagnostic SearchTimeline request keeps keyword search out of worker routes", async () => {
  const requests: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  const client: ReadClient = { graphql: async (_id, operation, variables) => {
    requests.push({ operation, variables });
    return {
      data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } },
    };
  }};
  const reader = new XActionsReadEngine(client, {
    ...endpoints,
    searchTimeline: { queryId: "s", operationName: "SearchTimeline" },
  }, parsers);
  const first = await reader.diagnosticSearchPage("(solana OR pumpfun) memecoin");
  assert.equal(first.nextCursor, "cursor-2");
  assert.equal(first.items[0]?.id, validTweet.id);
  assert.equal(requests[0]?.operation, "SearchTimeline");
  assert.equal(requests[0]?.variables.product, "Latest");
  assert.equal(requests[0]?.variables.rawQuery, "(solana OR pumpfun) memecoin");
  const second = await reader.diagnosticSearchPage("solana", "top", "opaque");
  assert.equal(second.items.length, 1);
  assert.equal(requests[1]?.variables.product, "Top");
  assert.equal(requests[1]?.variables.cursor, "opaque");
  await assert.rejects(reader.diagnosticSearchPage("   "), /invalid diagnostic search query/);
});

test("diagnostic search rejects malformed GraphQL response without advancing cursor", async () => {
  const client: ReadClient = { graphql: async () => ({ data: { search_by_raw_query: {} } }) };
  const reader = new XActionsReadEngine(client, {
    ...endpoints,
    searchTimeline: { queryId: "s", operationName: "SearchTimeline" },
  }, parsers);
  await assert.rejects(reader.diagnosticSearchPage("pumpfun"), /response shape changed/);
});

test("explicit terminal marker is required before closing a GraphQL checkpoint", () => {
  assert.throws(() => verifyHttpPageEnd([], 0, null), /ambiguous timeline end/);
  assert.throws(() => verifyHttpPageEnd([{ type: "TimelineAddEntries", entries: [] }], 0, null), /ambiguous timeline end/);
  assert.throws(() => verifyHttpPageEnd([{ type: "TimelineAddEntries" }], 3, null), /ambiguous timeline end/);
  assert.doesNotThrow(() => verifyHttpPageEnd([{ type: "TimelineTerminateTimeline" }], 0, null));
  assert.doesNotThrow(() => verifyHttpPageEnd([], 0, "opaque-next-page"));
});

test("timeline reader refuses empty GraphQL data without a confirmed terminal marker", async () => {
  const client: ReadClient = { graphql: async () => ({
    data: { user: { result: { timeline: { timeline: { instructions: [] } } } } },
  }) };
  const reader = new XActionsReadEngine(client, endpoints, {
    ...parsers, parseTimelineInstructions: () => ({ tweets: [], cursor: null }),
  });
  await assert.rejects(reader.timelinePage("123456"), /ambiguous timeline end/);
});

test("ListTimeline without bottom cursor or terminal instruction cannot mark task done", async () => {
  const client: ReadClient = { graphql: async () => ({
    data: { list: { tweets_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [] }] } } } },
  }) };
  const reader = new XActionsReadEngine(client, endpoints, {
    ...parsers,
    parseTimelineInstructions: () => ({ tweets: [], cursor: null }),
  });
  await assert.rejects(reader.listPage("1945268064792068152"), /ambiguous timeline end/);
});

test("explicit absence of verification is distinct from upstream parser default false", async () => {
  const client: ReadClient = { graphql: async () => ({
    data: { user: { result: { rest_id: "123", verification: { verified: false } } },
  } }) };
  const reader = new XActionsReadEngine(client, endpoints, {
    ...parsers,
    parseUserData: () => ({ username: "NASA", verified: false }),
  });
  const profile = await reader.profile("NASA");
  assert.equal(profile.verificationEvidence, "unverified");
  assert.equal(profile.isVerified, false);
});
