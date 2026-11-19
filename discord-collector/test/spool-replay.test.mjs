import test from "node:test";
import assert from "node:assert/strict";
import {replaySpoolEntries} from "../src/spool-replay.mjs";

test("replay stops at a hydration barrier and leaves the blocked and later events unacknowledged",async()=>{
  const processed=[];
  const acknowledged=[];
  let flushed=0;
  const result=await replaySpoolEntries({
    entries:[{sequence:"1"},{sequence:"2"},{sequence:"3"}],
    processEntry:async entry=>{
      processed.push(entry.sequence);
      return {ack:entry.sequence==="1"};
    },
    acknowledge:sequence=>acknowledged.push(sequence),
    flushAcks:()=>{flushed++},
  });
  assert.deepEqual(processed,["1","2"]);
  assert.deepEqual(acknowledged,["1"]);
  assert.equal(flushed,1);
  assert.deepEqual(result,{acknowledged:1,blocked:true,blockedSequence:"2"});
});

test("replay flushes earlier ACKs but never ACKs the event whose processing throws",async()=>{
  const acknowledged=[];
  let flushed=0;
  await assert.rejects(replaySpoolEntries({
    entries:[{sequence:"1"},{sequence:"2"}],
    processEntry:async entry=>{
      if(entry.sequence==="2")throw new Error("database unavailable");
      return {ack:true};
    },
    acknowledge:sequence=>acknowledged.push(sequence),
    flushAcks:()=>{flushed++},
  }),/database unavailable/);
  assert.deepEqual(acknowledged,["1"]);
  assert.equal(flushed,1);
});

test("replay does not process or ACK entries after collection stops",async()=>{
  const acknowledged=[];
  let processed=0;
  const result=await replaySpoolEntries({
    entries:[{sequence:"1"}],
    processEntry:async()=>{processed++;return {ack:true}},
    acknowledge:sequence=>acknowledged.push(sequence),
    flushAcks:()=>{},
    shouldContinue:()=>false,
  });
  assert.equal(processed,0);
  assert.deepEqual(acknowledged,[]);
  assert.deepEqual(result,{acknowledged:0,blocked:false,blockedSequence:null});
});

test("replay requires an explicit ACK decision",async()=>{
  await assert.rejects(replaySpoolEntries({
    entries:[{sequence:"1"}],
    processEntry:async()=>undefined,
    acknowledge:()=>{},
    flushAcks:()=>{},
  }),/explicitly return an ACK decision/);
});
