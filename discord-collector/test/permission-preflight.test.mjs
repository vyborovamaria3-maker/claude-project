import test from "node:test";
import assert from "node:assert/strict";
import {runDiscordPermissionPreflight} from "../src/permission-preflight.mjs";

const botId="123456789012345678";
const guildId="223456789012345678";
const channelId="323456789012345678";
const otherChannelId="423456789012345678";
const expiresAt="2026-12-19T00:00:00.000Z";
const now=new Date("2026-11-19T12:00:00.000Z");
const VIEW=1n<<10n;
const HISTORY=1n<<16n;
const ADMIN=1n<<3n;

function authorization(ids=[channelId]){
  return new Map(ids.map(id=>[id,{
    guildId,retentionDays:30,expiresAt,
    permissionReference:"test-consent",policyReviewReference:"test-policy",
  }]));
}

function jsonResponse(value,status=200,headers={}){
  return new Response(JSON.stringify(value),{
    status,
    headers:{"content-type":"application/json",...headers},
  });
}

function successfulFetch({permissions=VIEW|HISTORY,visibleIds=[channelId],channelTypes={}}={}){
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url);
    calls.push({path:parsed.pathname,authorization:options.headers.Authorization});
    if(parsed.pathname==="/api/v10/users/@me")return jsonResponse({id:botId});
    if(parsed.pathname===`/api/v10/guilds/${guildId}/channels`)
      return jsonResponse(visibleIds.map(id=>({
        id,guild_id:guildId,type:channelTypes[id]??0,
      })));
    const permissionPath="/api/v10/channels/"+channelId+"/permissions/member/"+botId;
    const otherPermissionPath="/api/v10/channels/"+otherChannelId+"/permissions/member/"+botId;
    if(parsed.pathname===permissionPath||parsed.pathname===otherPermissionPath)
      return jsonResponse({permissions:String(permissions)});
    return jsonResponse({message:"unexpected route"},404);
  };
  return {fetchImpl,calls};
}

test("preflight verifies only allowlisted text channels and computed bot permissions",async()=>{
  const fake=successfulFetch({visibleIds:[channelId,otherChannelId]});
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"test-secret-token",fetchImpl:fake.fetchImpl,now,
  });
  assert.equal(report.ok,true);
  assert.equal(report.status,"passed");
  assert.equal(report.checkedGuilds,1);
  assert.equal(report.checkedChannels,1);
  assert.equal(report.passedChannels,1);
  assert.equal(report.botId,botId);
  assert.deepEqual(report.guilds[0].channels[0].checks,{
    viewChannel:true,readMessageHistory:true,administrator:false,sendMessages:false,
  });
  assert.ok(fake.calls.some(call=>call.path===`/api/v10/channels/${channelId}/permissions/member/${botId}`));
  assert.ok(!fake.calls.some(call=>call.path.includes("/messages")));
  assert.ok(fake.calls.every(call=>call.authorization==="Bot test-secret-token"));
  assert.ok(!JSON.stringify(report).includes("test-secret-token"));
  assert.ok(!JSON.stringify(report).includes("message content"));
  // A visible but non-authorized channel must never be probed.
  assert.ok(!fake.calls.some(call=>call.path.includes(otherChannelId)));
});

test("a channel missing VIEW_CHANNEL is rejected",async()=>{
  const fake=successfulFetch({permissions:HISTORY});
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl:fake.fetchImpl,now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.guilds[0].channels[0].errorCode,"view_channel_missing");
});

test("a channel missing READ_MESSAGE_HISTORY is rejected",async()=>{
  const fake=successfulFetch({permissions:VIEW});
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl:fake.fetchImpl,now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.guilds[0].channels[0].checks.viewChannel,true);
  assert.equal(report.guilds[0].channels[0].checks.readMessageHistory,false);
  assert.equal(report.guilds[0].channels[0].errorCode,"read_message_history_missing");
});

test("administrator permission satisfies both read-only permission checks",async()=>{
  const fake=successfulFetch({permissions:ADMIN});
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl:fake.fetchImpl,now,
  });
  assert.equal(report.ok,true);
  assert.equal(report.guilds[0].channels[0].errorCode,"excessive_administrator_permission");
});

test("channel omitted from visible guild channels fails without probing it",async()=>{
  const fake=successfulFetch({visibleIds:[otherChannelId]});
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl:fake.fetchImpl,now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.guilds[0].channels[0].errorCode,"channel_not_visible_or_missing");
  assert.ok(!fake.calls.some(call=>call.path.includes(`/channels/${channelId}/permissions/`)));
});

test("a missing guild or bot membership fails the guild's authorized channels",async()=>{
  const calls=[];
  const fetchImpl=async(url)=>{
    const path=new URL(url).pathname;
    calls.push(path);
    if(path==="/api/v10/users/@me")return jsonResponse({id:botId});
    if(path===`/api/v10/guilds/${guildId}/channels`)return jsonResponse({code:10004},404);
    return jsonResponse({},500);
  };
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl,now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.guilds[0].errorCode,"guild_unavailable_or_bot_not_member");
  assert.ok(!calls.some(path=>path.includes("/permissions/member/")));
});

test("unsupported channel types fail closed",async()=>{
  const fake=successfulFetch({channelTypes:{[channelId]:15}});
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl:fake.fetchImpl,now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.guilds[0].channels[0].errorCode,"unsupported_channel_type");
});

test("permission endpoint forbidden fails closed without exposing API response bodies",async()=>{
  const calls=[];
  const fetchImpl=async(url)=>{
    const path=new URL(url).pathname;
    calls.push(path);
    if(path==="/api/v10/users/@me")return jsonResponse({id:botId});
    if(path===`/api/v10/guilds/${guildId}/channels`)
      return jsonResponse([{id:channelId,guild_id:guildId,type:0}]);
    return jsonResponse({message:"private diagnostic"},403);
  };
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"secret",fetchImpl,now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.guilds[0].channels[0].errorCode,"view_channel_denied");
  assert.ok(!JSON.stringify(report).includes("private diagnostic"));
  assert.ok(!JSON.stringify(report).includes("secret"));
});

test("rate limits are retried only within the configured wait budget",async()=>{
  let guildCalls=0;
  const waits=[];
  const fetchImpl=async(url)=>{
    const path=new URL(url).pathname;
    if(path==="/api/v10/users/@me")return jsonResponse({id:botId});
    if(path===`/api/v10/guilds/${guildId}/channels`){
      guildCalls++;
      if(guildCalls===1)return jsonResponse({retry_after:0.01},429,{"retry-after":"0.01"});
      return jsonResponse([{id:channelId,guild_id:guildId,type:0}]);
    }
    return jsonResponse({permissions:String(VIEW|HISTORY)});
  };
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl,now,
    maxRetries:1,maxRetryDelayMs:100,sleep:async ms=>waits.push(ms),
  });
  assert.equal(report.ok,true);
  assert.equal(guildCalls,2);
  assert.deepEqual(waits,[10]);
});

test("rate limits beyond the bounded retry budget stop the preflight",async()=>{
  const fetchImpl=async(url)=>{
    const path=new URL(url).pathname;
    if(path==="/api/v10/users/@me")return jsonResponse({id:botId});
    return jsonResponse({retry_after:30},429,{"retry-after":"30"});
  };
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl,now,
    maxRetries:2,maxRetryDelayMs:100,
  });
  assert.equal(report.ok,false);
  assert.equal(report.errorCode,"discord_rate_limited");
});

test("expired authorization leases are not sent to Discord",async()=>{
  const expired=authorization();
  expired.get(channelId).expiresAt="2026-11-18T00:00:00.000Z";
  let calls=0;
  const report=await runDiscordPermissionPreflight({
    authorization:expired,token:"token",fetchImpl:async()=>{calls++;return jsonResponse({})},now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.guilds[0].channels[0].errorCode,"authorization_expired");
  assert.equal(calls,0);
});

test("preflight channel budget is enforced before any API request",async()=>{
  let calls=0;
  const report=await runDiscordPermissionPreflight({
    authorization:authorization([channelId,otherChannelId]),token:"token",
    fetchImpl:async()=>{calls++;return jsonResponse({})},now,maxChannels:1,
  });
  assert.equal(report.ok,false);
  assert.equal(report.errorCode,"preflight_channel_limit_exceeded");
  assert.equal(report.failedChannels,2);
  assert.equal(calls,0);
});

test("invalid token fails closed and never appears in the report",async()=>{
  const report=await runDiscordPermissionPreflight({
    authorization:authorization(),token:"very-secret-token",
    fetchImpl:async()=>jsonResponse({message:"unauthorized"},401),now,
  });
  assert.equal(report.ok,false);
  assert.equal(report.errorCode,"invalid_bot_token");
  assert.ok(!JSON.stringify(report).includes("very-secret-token"));
});

test("plain HTTP API overrides are rejected",async()=>{
  await assert.rejects(runDiscordPermissionPreflight({
    authorization:authorization(),token:"token",fetchImpl:async()=>jsonResponse({}),
    baseUrl:"http://discord.test/api/v10",now,
  }),/HTTPS/);
});
