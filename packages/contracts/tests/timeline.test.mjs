import test from "node:test";
import assert from "node:assert/strict";
import { buildTimelineEvent, buildEvidenceRef, buildEntityRef, formatTokenId, toUtcIso } from "../dist/index.js";

const MINT = "So11111111111111111111111111111111111111112";
const eventTime = "2026-10-17T20:00:00Z";
const observedAt = "2026-10-17T20:03:00Z";
const entity = buildEntityRef({
  kind:"token",canonicalId:formatTokenId("solana",MINT),
  firstSeenAt:eventTime,lastSeenAt:observedAt,
});
const evidence = buildEvidenceRef({sourceKind:"x_tweet",tweetId:"1001",observedAt,occurredAt:eventTime});

test("timeline event serializes stable provenance and preserves point-in-time clocks", () => {
  const result = buildTimelineEvent({
    eventKey:"x:tweet:1001:version:1",
    kind:"tweet_published",occurredAt:eventTime,observedAt,
    entityRefs:[entity],evidenceRef:evidence,
    payload:{mentions_5m:1,isVerified:null,labels:["token"],confidence:0.6},
  });
  assert.equal(result.schemaVersion, "timeline-v1");
  assert.equal(result.occurredAt, "2026-10-17T20:00:00.000Z");
  assert.equal(result.observedAt, "2026-10-17T20:03:00.000Z");
  assert.equal(result.entityRefs[0].canonicalId,"solana:"+MINT);
  assert.equal(JSON.parse(JSON.stringify(result)).evidenceRef.sourceId,"x:tweet:1001");
});

test("no false successes for missing evidence, non-JSON data or empty keys", () => {
  const base = { eventKey:"key1",kind:"tweet_published",occurredAt:eventTime,observedAt,entityRefs:[entity],evidenceRef:evidence };
  assert.throws(() => buildTimelineEvent({...base,entityRefs:[]}), /entity provenance/);
  assert.throws(() => buildTimelineEvent({...base,evidenceRef:{}}), /requires evidence/);
  assert.throws(() => buildTimelineEvent({...base,eventKey:" "}), /eventKey/);
  assert.throws(() => buildTimelineEvent({...base,payload:{unsafe:NaN}}), /JSON-safe/);
  assert.throws(() => buildTimelineEvent({...base,payload:{unsafe:BigInt(2)}}), /JSON-safe/);
  assert.throws(() => buildTimelineEvent({...base,kind:"impossible"}), /Unsupported/);
  assert.throws(() => toUtcIso("2026-10-17T20:30:00"), /timezone/);
  assert.throws(() => toUtcIso("2026-13-17T20:30:00Z"), /Invalid timestamp/);
});
