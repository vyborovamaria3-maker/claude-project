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
