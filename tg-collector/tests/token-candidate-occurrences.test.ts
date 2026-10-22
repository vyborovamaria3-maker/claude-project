import test from "node:test";
import assert from "node:assert/strict";
import {sameObservedMessageRevision} from "../src/analytics/token-candidate-occurrences.js";

const postedAt=new Date("2026-10-19T22:00:00.000Z");
const editedAt=new Date("2026-10-20T01:00:00.000Z");
const candidate={
  text:"Mint So11111111111111111111111111111111111111112",
  message_date:postedAt,
  edited_at:editedAt,
  peer_id:"-10012345678",
};
const locked={
  text:candidate.text,deleted_at:null,posted_at:new Date(postedAt),
  edited_at:new Date(editedAt),peer_id:candidate.peer_id,
};

test("stable source revision survives post-RPC row-lock check",()=>{
  assert.equal(sameObservedMessageRevision(candidate,locked),true);
  assert.equal(sameObservedMessageRevision(candidate,undefined),false);
  // No identity? Native analytics can continue, but no verified social outbox
  // event can be emitted until the source peer ID has been attested.
  assert.equal(sameObservedMessageRevision(
    {...candidate,peer_id:null},{...locked,peer_id:null},
  ),true);
});

test("same body with changed edit time, posted time, or peer ID fails closed",()=>{
  const changes=[
    {edited_at:new Date(editedAt.getTime()+1)},
    {edited_at:null},
    {posted_at:new Date(postedAt.getTime()+1)},
    {posted_at:null},
    {peer_id:"-10022222222"},
    {peer_id:null},
    {text:candidate.text+" stale"},
    {deleted_at:new Date("2026-10-20T01:02:00Z")},
    {edited_at:new Date("not a timestamp")},
  ];
  for(const change of changes){
    assert.equal(sameObservedMessageRevision(candidate,{...locked,...change}),false,
      "stale Telegram evidence must be re-read before token attribution");
  }
  assert.equal(sameObservedMessageRevision({...candidate,edited_at:null},locked),false);
  assert.equal(sameObservedMessageRevision({...candidate,message_date:null},locked),false);
});

test("historical messages with null clocks still match if unchanged",()=>{
  assert.equal(sameObservedMessageRevision(
    {...candidate,message_date:null,edited_at:null},
    {...locked,posted_at:null,edited_at:null},
  ),true);
  assert.equal(sameObservedMessageRevision(
    {...candidate,edited_at:new Date("not a date")},locked,
  ),false);
});
