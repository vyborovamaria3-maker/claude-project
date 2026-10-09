import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeGraphSignals, type Observation } from "../lib/trade/graph-signals";
const now = 10_000, windowMs = 1000;
function post(id: string, at = 9500, handle = id, entities = ["token:a"], influence = 100): Observation {
  return { tweetId: id, handle, postedAt: at, entities, influence };
}
test("empty data produces no signals", () => assert.deepEqual(analyzeGraphSignals([], now, windowMs), []));
test("adjacent windows exclude old and future posts", () => {
  const [s] = analyzeGraphSignals([post("old",8000),post("prev",9000),post("current",10000),post("future",10001)],now,windowMs);
  assert.equal(s.tweets,1); assert.equal(s.previousTweets,1);
});
test("duplicate posts and entities cannot inflate signals", () => {
  const p = post("one",9500,"@Alice",["token:a","token:a","entity:tag:b"]);
  const s = analyzeGraphSignals([p,p,post("two",9500,"alice")],now,windowMs).find(s=>s.entity==="token:a")!;
  assert.equal(s.tweets,2); assert.equal(s.authors,1); assert.equal(s.relatedEntities,1);
});
test("many posts by one author do not gain author diversity", () => {
  const posts = Array.from({length:20},(_,i)=>post(String(i),9500,"one"));
  const concentrated = analyzeGraphSignals(posts,now,windowMs)[0];
  const diverse = analyzeGraphSignals(posts.map((p,i)=>({...p,handle:String(i)})),now,windowMs)[0];
  assert.ok(diverse.score > concentrated.score); assert.equal(diverse.level,"CRITICAL");
});
test("influence remains bounded and NaN does not poison score", () => {
  const signals = analyzeGraphSignals([post("a",9500,"a",["a"],NaN),post("b",9500,"b",["b"],10000)],now,windowMs);
  assert.ok(signals.every(s=>Number.isFinite(s.score)&&s.score>=0&&s.score<=100));
});
test("invalid windows fail before calculation", () => {
  assert.throws(()=>analyzeGraphSignals([],now,0)); assert.throws(()=>analyzeGraphSignals([],NaN));
});
test("declining activity contributes no growth score", () => {
  const previous=Array.from({length:10},(_,i)=>post("prev"+i,8500));
  const s=analyzeGraphSignals([...previous,post("now")],now,windowMs)[0];
  assert.equal(s.previousTweets,10); assert.ok(s.baseScore<30);
});
