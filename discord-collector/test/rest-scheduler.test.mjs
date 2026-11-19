import test from "node:test";
import assert from "node:assert/strict";
import {DiscordRestScheduler} from "../src/rest-scheduler.mjs";

test("REST scheduler serializes calls and honors preflight/recovery/backfill priority",async()=>{
  const order=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const scheduler=new DiscordRestScheduler({minIntervalMs:0});
  const first=scheduler.run("backfill",async()=>{order.push("active");await gate;});
  await Promise.resolve();
  const backfill=scheduler.run("backfill",async()=>order.push("backfill"));
  const recovery=scheduler.run("recovery",async()=>order.push("recovery"));
  const preflight=scheduler.run("preflight",async()=>order.push("preflight"));
  release();
  await Promise.all([first,backfill,recovery,preflight]);
  assert.deepEqual(order,["active","preflight","recovery","backfill"]);
});

test("scheduler rejects unknown priorities and applies a bounded queue",async()=>{
  const scheduler=new DiscordRestScheduler({minIntervalMs:0,maxQueue:1});
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  const active=scheduler.run("ingress",()=>gate);
  await Promise.resolve();
  const queued=scheduler.run("backfill",async()=>true);
  assert.throws(()=>scheduler.run("preflight",async()=>true),error=>error.code==="DISCORD_REST_QUEUE_FULL");
  assert.throws(()=>scheduler.run("unknown",async()=>true),/priority/);
  release(true);
  await Promise.all([active,queued]);
});

test("scheduler counts rate-limit responses without exposing their contents",async()=>{
  const scheduler=new DiscordRestScheduler({minIntervalMs:0});
  const error=new Error("429");
  error.status=429;
  await assert.rejects(scheduler.run("preflight",async()=>{throw error}),error);
  assert.equal(scheduler.rateLimitCount,1);
});
