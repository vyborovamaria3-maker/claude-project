import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSourceLoop } from "../scripts/supervisor-core.mjs";
import { parseArguments } from "../scripts/supervise.mjs";

const cli=fileURLToPath(new URL("../scripts/supervise.mjs",import.meta.url));
const cwd=fileURLToPath(new URL("..",import.meta.url));

test("supervisor --help is offline and does not require credentials",()=>{
  const run=spawnSync(process.execPath,[cli,"--help"],{
    cwd,encoding:"utf8",env:{PATH:process.env.PATH,HOME:process.env.HOME},
  });
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/foreground process/);
  assert.match(run.stdout,/--sources x,tg,blockchain/);
});

test("supervisor refuses to start without both explicit opt-ins",()=>{
  const run=spawnSync(process.execPath,[cli,"--sources","blockchain"],{
    cwd,encoding:"utf8",env:{PATH:process.env.PATH,HOME:process.env.HOME},
  });
  assert.equal(run.status,1);
  assert.match(run.stderr,/source_or_destination_operation_failed/);
  assert.doesNotMatch(run.stderr,/postgres:|password=|SOLANA_TRADE_DB_PATH=/);
});

test("CLI forbids duplicate, missing or unknown sources and unsafe numeric values",()=>{
  for(const args of [
    ["--sources","x,x"],["--sources","x,unknown"],["--sources","x","--source","tg"],
    ["--sources",""],["--sources","tg","--lease-ms","0"],
    ["--sources","tg","--max-failures","0"],
    ["--sources","tg","--poll-ms","not-a-number"],
    ["--sources","tg","--max-batches","-1"],
  ])assert.throws(()=>parseArguments(args),Error);
  assert.deepEqual(parseArguments(["--sources","x,tg","--max-batches","10"]).sources,["x","tg"]);
  assert.equal(parseArguments(["--source","blockchain","--lease-ms=60000"]).leaseMs,60000);
});

test("foreground loop claims sequentially and respects bounded run",async()=>{
  const results=[];
  let active=0,maxActive=0;
  const signal=new AbortController();
  const summary=await runSourceLoop({
    source:"x",signal:signal.signal,maxBatches:3,paceMs:0,pollMs:100,
    onReport:event=>results.push(event),
    runBatch:async()=>{
      active++;
      maxActive=Math.max(maxActive,active);
      await Promise.resolve();
      active--;
      return {claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0};
    },
  });
  assert.equal(maxActive,1);
  assert.equal(summary.batches,3);
  assert.equal(summary.delivered,3);
  assert.equal(results.length,3);
  assert.ok(results.every(item=>item.kind==="batch" && !Object.hasOwn(item,"payload")));
});

test("SIGINT-style cancellation drains in-flight batch, never starts a second claim",async()=>{
  const stop=new AbortController();
  let claims=0;
  const summary=await runSourceLoop({
    source:"blockchain",signal:stop.signal,pollMs:100,paceMs:0,
    runBatch:async()=>{
      claims++;
      stop.abort();  // mimic signal arriving while a batch is in progress
      await Promise.resolve();  // batch still commits/ACKs
      return {claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0};
    },
  });
  assert.equal(claims,1);
  assert.equal(summary.delivered,1);
  assert.equal(summary.stopped,true);
});

test("two independent sources can make progress without sharing a claim queue",async()=>{
  let tg=0,chain=0;
  const stop=new AbortController();
  const [a,b]=await Promise.all([
    runSourceLoop({source:"tg",signal:stop.signal,pollMs:100,paceMs:0,maxBatches:2,
      runBatch:async()=>{tg++;return {claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0}}},
    }),
    runSourceLoop({source:"blockchain",signal:stop.signal,pollMs:100,paceMs:0,maxBatches:2,
      runBatch:async()=>{chain++;return {claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0}}},
    }),
  ]);
  assert.equal(a.delivered,2);
  assert.equal(b.delivered,2);
  assert.equal(tg,2);
  assert.equal(chain,2);
});

test("source errors are redacted, retried and cut off at safety threshold",async()=>{
  const messages=[];
  const stop=new AbortController();
  let attempts=0;
  await assert.rejects(runSourceLoop({
    source:"tg",signal:stop.signal,pollMs:100,maxFailures:2,
    onReport:event=>messages.push(event),
    runBatch:async()=>{attempts++;throw new Error("postgres://secret:password@example.test")},
  }),/failure_threshold_reached/);
  assert.equal(attempts,2);
  assert.equal(messages.length,2);
  assert.ok(messages.every(item=>item.kind==="error" &&
    !JSON.stringify(item).includes("secret")));
});

test("failed delivery counters trigger threshold; successful delivery resets it",async()=>{
  const sequence=[
    {claimed:1,delivered:0,duplicates:0,failed:1,lostLeases:1},
    {claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0},
    {claimed:1,delivered:0,duplicates:0,failed:1,lostLeases:0},
  ];
  const result=await runSourceLoop({
    source:"x",signal:new AbortController().signal,
    maxFailures:2,maxBatches:3,paceMs:0,pollMs:100,
    runBatch:async()=>sequence.shift(),
  });
  assert.equal(result.batches,3);
  assert.equal(result.delivered,1);
  assert.equal(result.failed,2);
  assert.equal(result.lostLeases,1);
});
