import test from "node:test";
import assert from "node:assert/strict";
import {RestScheduler} from "../src/rest-scheduler.mjs";

test("REST scheduler prioritizes preflight and recovery between bounded tasks",async()=>{
  const scheduler=new RestScheduler({maxPending:5});
  const order=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const first=scheduler.run(async()=>{order.push("first");await gate},{priority:2});
  const backfill=scheduler.run(async()=>{order.push("backfill")},{priority:2});
  const recovery=scheduler.run(async()=>{order.push("recovery")},{priority:1});
  const preflight=scheduler.run(async()=>{order.push("preflight")},{priority:0});
  release();
  await Promise.all([first,backfill,recovery,preflight]);
  assert.deepEqual(order,["first","preflight","recovery","backfill"]);
});

test("REST scheduler preserves FIFO order within equal priority",async()=>{
  const scheduler=new RestScheduler();
  const order=[];
  await Promise.all([
    scheduler.run(()=>order.push("a"),{priority:1}),
    scheduler.run(()=>order.push("b"),{priority:1}),
    scheduler.run(()=>order.push("c"),{priority:1}),
  ]);
  assert.deepEqual(order,["a","b","c"]);
});

test("REST scheduler applies bounded queue backpressure",async()=>{
  const scheduler=new RestScheduler({maxPending:1});
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const running=scheduler.run(()=>gate,{priority:2});
  const queued=scheduler.run(()=>true,{priority:2});
  await assert.rejects(scheduler.run(()=>true,{priority:0}),/queue_full/);
  release(true);
  await Promise.all([running,queued]);
});

test("REST scheduler rejects invalid priorities and callbacks",async()=>{
  const scheduler=new RestScheduler();
  assert.throws(()=>scheduler.run(null),/function/);
  assert.throws(()=>scheduler.run(()=>{}, {priority:4}),/priority/);
});

test("REST scheduler continues draining queued work after a request fails during an API outage",async()=>{
  const scheduler=new RestScheduler({maxPending:2});
  const failed=scheduler.run(async()=>{
    throw Object.assign(new Error("Discord REST unavailable"),{status:503});
  },{priority:0});
  const next=scheduler.run(async()=>"recovered",{priority:1});
  await assert.rejects(failed,/Discord REST unavailable/);
  assert.equal(await next,"recovered");
  assert.equal(scheduler.pendingCount,0);
});
