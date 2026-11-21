import test from "node:test";
import assert from "node:assert/strict";
import {isTransientDiscordRestError,isTransientPermissionPreflightReport,permissionPreflightRetryBaseMs,retryDelayMs} from "../src/retry-policy.mjs";

test("REST retry classifier recognizes HTTP throttling, server failures and nested network faults",()=>{
  assert.equal(isTransientDiscordRestError({status:429}),true);
  assert.equal(isTransientDiscordRestError({status:503}),true);
  assert.equal(isTransientDiscordRestError({cause:{code:"ECONNRESET"}}),true);
  assert.equal(isTransientDiscordRestError({name:"TimeoutError"}),true);
  assert.equal(isTransientDiscordRestError({code:"discord_rest_scheduler_queue_full"}),true);
  assert.equal(isTransientDiscordRestError({cause:{cause:{code:"UND_ERR_SOCKET"}}}),true);
});

test("REST retry classifier does not retry permanent authorization or missing-resource failures",()=>{
  for(const error of [
    {status:400},{status:401},{status:403},{status:404},{status:422},
    {code:10008,status:404},{code:"invalid_payload"},
  ])assert.equal(isTransientDiscordRestError(error),false);
});

test("permission preflight retries only reports containing exclusively transient API failures",()=>{
  assert.equal(isTransientPermissionPreflightReport({
    ok:false,errorCode:"discord_api_unavailable",
    guilds:[{errorCode:"discord_api_unavailable",channels:[{errorCode:"discord_api_unavailable"}]}],
  }),true);
  assert.equal(isTransientPermissionPreflightReport({
    ok:false,errorCode:"discord_rate_limited",
    guilds:[{errorCode:"discord_rate_limited",channels:[{errorCode:"discord_rate_limited"}]}],
  }),true);
  assert.equal(isTransientPermissionPreflightReport({
    ok:false,errorCode:"discord_api_unavailable",
    guilds:[{errorCode:"discord_api_unavailable",channels:[
      {errorCode:"discord_api_unavailable"},{errorCode:"view_channel_missing"},
    ]}],
  }),false);
  assert.equal(isTransientPermissionPreflightReport({
    ok:false,errorCode:"discord_forbidden",
    guilds:[{errorCode:"discord_forbidden",channels:[{errorCode:"channel_access_denied"}]}],
  }),false);
  assert.equal(isTransientPermissionPreflightReport({ok:false,guilds:[]}),false);
});

test("retry delay grows exponentially and remains capped during a prolonged outage",()=>{
  assert.deepEqual(
    Array.from({length:7},(_,attempt)=>retryDelayMs(attempt)),
    [1_000,2_000,4_000,8_000,16_000,32_000,64_000],
  );
  assert.equal(retryDelayMs(20),300_000);
  assert.equal(retryDelayMs(3,{baseMs:30_000,maxMs:300_000}),240_000);
  assert.throws(()=>retryDelayMs(-1),/attempt/);
  assert.throws(()=>retryDelayMs(1,{baseMs:10,maxMs:5}),/bounds/);
});

test("permission preflight honors nested rate-limit reports and thrown HTTP 429 responses",()=>{
  assert.equal(permissionPreflightRetryBaseMs({
    ok:false,guilds:[{channels:[{errorCode:"discord_rate_limited"}]}],
  }),30_000);
  assert.equal(permissionPreflightRetryBaseMs({ok:false,errorCode:"discord_api_unavailable"}),1_000);
  assert.equal(permissionPreflightRetryBaseMs(null,{status:"429"}),30_000);
});
