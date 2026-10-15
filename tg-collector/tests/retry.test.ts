import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTelegramError } from "../src/queue/retry.js";

test("FloodWait pauses globally, slowmode waits only per task", () => {
  assert.deepEqual(classifyTelegramError({message:"FLOOD_WAIT_60",seconds:60},1),
    {action:"delay",code:"TG_FLOOD_WAIT",seconds:75,global:true});
  assert.deepEqual(classifyTelegramError(new Error("SLOWMODE_WAIT_12"),1),
    {action:"delay",code:"TG_SLOWMODE_WAIT",seconds:27,global:false});
});
test("account restriction blocks rather than silently rotating", () => {
  assert.deepEqual(classifyTelegramError(new Error("PEER_FLOOD"),1),
    {action:"halt",code:"TG_ACCOUNT_RESTRICTED",scope:"account"});
});
test("revoked sessions stop collection and require login", () => {
  for (const code of ["AUTH_KEY_UNREGISTERED","SESSION_REVOKED","AUTH_KEY_DUPLICATED"]) {
    assert.deepEqual(classifyTelegramError(new Error(code),1),
      {action:"halt",code:"TG_SESSION_INVALID",scope:"session"});
  }
});
test("source access and unknown transient errors have separate policy", () => {
  assert.equal(classifyTelegramError(new Error("CHANNEL_PRIVATE"),1).action,"failed");
  assert.deepEqual(classifyTelegramError(new Error("ECONNRESET"),2),
    {action:"delay",code:"TG_TRANSIENT_ERROR",seconds:60,global:false});
  assert.equal(classifyTelegramError(new Error("ECONNRESET"),5).action,"failed");
});
