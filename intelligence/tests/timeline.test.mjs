import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEntityRef,buildEvidenceRef,buildTimelineEvent,formatTokenId,
} from "@claude-project/contracts";
import {ingestTimelineEvent,queryTokenTimeline} from "../dist/index.js";

const NOW="2026-10-18T00:05:00Z";
const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
const entity=buildEntityRef({kind:"token",canonicalId:token,firstSeenAt:NOW,lastSeenAt:NOW});
const evidence=buildEvidenceRef({sourceKind:"x_tweet",tweetId:"1001",observedAt:NOW});
const event=buildTimelineEvent({
  kind:"tweet_published",eventKey:"x:1001:v1",entityRefs:[entity],
  evidenceRef:evidence,occurredAt:"2026-10-18T00:00:00Z",observedAt:NOW,
  payload:{mentions:1}
});

test("timeline ingestion requires prior inbox and canonical evidence",async()=>{
  const calls=[];
  const tx={query:async(sql,params)=>{calls.push({sql,params});
    return{rows:sql.includes("RETURNING event_key")?[{event_key:event.eventKey}]:[]};
  }};
  assert.equal(await ingestTimelineEvent(tx,"x","tweet_created",event),true);
  assert.equal(calls.length,2);
  assert.match(calls[0].sql,/timeline_events/);
  assert.match(calls[1].sql,/timeline_event_entities/);
  await assert.rejects(ingestTimelineEvent(tx,"tg","tweet_created",event),/does not belong/);
});

test("query is always point-in-time filtered on both clocks",async()=>{
  const calls=[];
  const tx={query:async(sql,params)=>{calls.push({sql,params});return{rows:[]};}};
  await queryTokenTimeline(tx,token,NOW,NOW,100);
  assert.match(calls[0].sql,/occurred_at <= \$2 AND t.observed_at <= \$3/);
  await assert.rejects(queryTokenTimeline(tx,token,NOW,NOW,501),/limit/);
  await assert.rejects(queryTokenTimeline(tx,"solana:bad",NOW,NOW),/Noncanonical/);
});

test("observedAt must be identical to source evidence time",async()=>{
  const tx={query:async()=>({rows:[{event_key:"x:1001:v1"}]})};
  await assert.rejects(ingestTimelineEvent(tx,"x","tweet_created",{
    ...event,observedAt:"2026-10-18T00:07:00Z"
  }),/observedAt/);
});
