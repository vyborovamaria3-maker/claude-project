import test from "node:test";
import assert from "node:assert/strict";
import {replaySpoolEntry} from "../src/spool-replay.mjs";

const event={
  kind:"edited",messageId:"123456789012345678",guildId:"223456789012345678",
  channelId:"323456789012345678",authorId:null,content:null,
  createdAt:null,editedAt:null,receivedAt:"2026-11-19T12:00:00.000Z",
};
const entry={sequence:"1",event};

test("pre-login replay keeps hydration-dependent records durable and unacknowledged",async()=>{
  let stored=0,coverage=0;
  const result=await replaySpoolEntry({
    entry,allowHydration:false,
    store:async()=>{stored++},
    recordCoverageFailure:async()=>{coverage++},
  });
  assert.deepEqual(result,{ack:false,status:"needs_hydration"});
  assert.equal(stored,0);
  assert.equal(coverage,0);
});

test("ready replay hydrates and stores before allowing acknowledgement",async()=>{
  let stored=0;
  const hydrated={id:event.messageId,guildId:event.guildId,channelId:event.channelId,
    author:{id:"423456789012345678"},content:"hydrated",createdAt:new Date("2026-11-19T11:00:00Z"),
    editedAt:new Date("2026-11-19T11:30:00Z")};
  const result=await replaySpoolEntry({
    entry,allowHydration:true,hydrate:async()=>hydrated,
    store:async(message,kind)=>{assert.equal(message,hydrated);assert.equal(kind,"edited");stored++},
    recordCoverageFailure:async()=>assert.fail("no coverage failure expected"),
  });
  assert.deepEqual(result,{ack:true,status:"stored"});
  assert.equal(stored,1);
});

test("definitive 404 records a coverage failure before acknowledgement",async()=>{
  const failures=[];
  const result=await replaySpoolEntry({
    entry,hydrate:async()=>{const error=new Error("missing");error.status=404;throw error},
    store:async()=>assert.fail("unhydratable message must not be stored"),
    recordCoverageFailure:async(...args)=>failures.push(args),
  });
  assert.deepEqual(result,{ack:true,status:"coverage_gap"});
  assert.deepEqual(failures,[[event,"message_not_hydratable","1"]]);
});

test("transient hydration errors reject replay and therefore retain the spool record",async()=>{
  const error=new Error("temporary");
  await assert.rejects(replaySpoolEntry({
    entry,hydrate:async()=>{throw error},
    store:async()=>assert.fail("store must not run"),
    recordCoverageFailure:async()=>assert.fail("transient failure is not a terminal coverage gap"),
  }),error);
});

test("revoked records are acknowledged without hydration or persistence",async()=>{
  const result=await replaySpoolEntry({
    entry,authorized:false,allowHydration:false,
    store:async()=>assert.fail("revoked event must not be stored"),
    recordCoverageFailure:async()=>assert.fail("revocation is not a hydration gap"),
  });
  assert.deepEqual(result,{ack:true,status:"revoked"});
});

test("delete events do not require REST hydration",async()=>{
  const deleted={...entry,event:{...event,kind:"deleted",createdAt:null,editedAt:null,authorId:null,content:null}};
  let stored=0;
  const result=await replaySpoolEntry({
    entry:deleted,allowHydration:false,
    store:async(message,kind)=>{assert.equal(kind,"deleted");stored++},
    recordCoverageFailure:async()=>assert.fail("delete events are self-contained"),
  });
  assert.deepEqual(result,{ack:true,status:"stored"});
  assert.equal(stored,1);
});
