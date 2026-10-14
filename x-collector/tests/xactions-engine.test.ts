import test from "node:test";
import assert from "node:assert/strict";
import { XActionsReadEngine, type ReadClient, type ReadParsers } from "../src/xactions/engine";

const validTweet = {
  id: "1878727153048777016", text: "hello", author: { username: "NASA" },
  metrics: { likes: 10 }, createdAt: "2026-10-12T00:00:00.000Z",
};

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

test("malformed list response must fail instead of silently marking complete", async () => {
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
