import test from "node:test";
import assert from "node:assert/strict";
import {isExpiredObservation} from "../src/storage.mjs";
const observation={kind:"observed",occurredAt:"2024-05-01T00:00:00Z"};
const clock=new Date("2026-11-18T12:00:00Z");
test("source-old content expires before reaching the database",()=>{
  assert.equal(isExpiredObservation(observation,30,clock),true);
  assert.equal(isExpiredObservation({...observation,occurredAt:"2026-11-18T11:00:00Z"},30,clock),false);
});
test("deletion always permitted to clear historical content",()=>{
  assert.equal(isExpiredObservation({...observation,kind:"deleted"},30,clock),false);
});
test("no source timestamp and implausible future timestamps are rejected",()=>{
  assert.throws(()=>isExpiredObservation({kind:"observed",occurredAt:null},30,clock));
  assert.throws(()=>isExpiredObservation({...observation,occurredAt:"2027-01-01T00:00:00Z"},30,clock));
});
test("retention is bounded",()=>{
  assert.throws(()=>isExpiredObservation(observation,0,clock));
  assert.throws(()=>isExpiredObservation(observation,366,clock));
});
