import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runPermissionPreflightCli} from "../src/preflight-cli.mjs";

const botId="123456789012345678";
const guildId="223456789012345678";
const channelId="323456789012345678";
const now=new Date("2026-11-19T12:00:00.000Z");
const validDocument={
  version:2,
  mode:"collect",
  guilds:[{
    guild_id:guildId,
    channel_ids:[channelId],
    community_permission_reference:"test-consent",
    community_permission_expires_at:"2026-12-19T00:00:00Z",
    policy_review_reference:"test-policy",
    policy_review_expires_at:"2026-12-19T00:00:00Z",
    reviewed_by:"ci",
    retention_days:30,
  }],
};

function fixture(document=validDocument){
  const directory=mkdtempSync(join(tmpdir(),"potapoff-discord-preflight-cli-"));
  const path=join(directory,"authorization.json");
  writeFileSync(path,JSON.stringify(document),{mode:0o600});
  return {directory,path,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

function jsonResponse(value,status=200){
  return new Response(JSON.stringify(value),{
    status,headers:{"content-type":"application/json"},
  });
}

function fakeFetch(permissions="66560"){
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    calls.push({path,authorization:options.headers.Authorization});
    if(path==="/api/v10/users/@me")return jsonResponse({id:botId});
    if(path===`/api/v10/guilds/${guildId}/channels`)
      return jsonResponse([{id:channelId,guild_id:guildId,type:0}]);
    if(path===`/api/v10/channels/${channelId}/permissions/member/${botId}`)
      return jsonResponse({permissions});
    return jsonResponse({message:"unexpected route"},404);
  };
  return {fetchImpl,calls};
}

test("standalone preflight runs without collector, database, spool or Gateway settings",async()=>{
  const f=fixture();
  const fake=fakeFetch();
  const output=[];
  try{
    const result=await runPermissionPreflightCli({
      env:{
        DISCORD_AUTHORIZATION_PATH:f.path,
        DISCORD_BOT_TOKEN:"cli-secret-token",
        DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED:"true",
        DISCORD_PERMISSION_PREFLIGHT_ENABLED:"true",
      },
      fetchImpl:fake.fetchImpl,
      write:value=>output.push(value),
      now,
    });
    assert.equal(result.exitCode,0);
    assert.equal(result.result.readyForGateway,true);
    assert.equal(result.result.ok,true);
    assert.equal(result.result.messageContentIntent.operatorAttested,true);
    assert.equal(result.result.messageContentIntent.independentlyVerified,false);
    assert.equal(result.result.preflightGateEnabled,true);
    assert.equal(fake.calls.length,3);
    assert.ok(fake.calls.every(call=>call.authorization==="Bot cli-secret-token"));
    assert.ok(!output.join("\n").includes("cli-secret-token"));
    assert.ok(!output.join("\n").includes("message content"));
  }finally{f.cleanup()}
});

test("channel permission success is not reported as Gateway-ready without Message Content attestation",async()=>{
  const f=fixture();
  const fake=fakeFetch();
  const output=[];
  try{
    const result=await runPermissionPreflightCli({
      env:{DISCORD_AUTHORIZATION_PATH:f.path,DISCORD_BOT_TOKEN:"token",DISCORD_PERMISSION_PREFLIGHT_ENABLED:"true"},
      fetchImpl:fake.fetchImpl,write:value=>output.push(value),now,
    });
    assert.equal(result.result.ok,true);
    assert.equal(result.result.readyForGateway,false);
    assert.equal(result.result.messageContentIntent.operatorAttested,false);
    assert.equal(result.exitCode,1);
  }finally{f.cleanup()}
});

test("permission denial makes standalone preflight fail without returning API body or token",async()=>{
  const f=fixture();
  const fake=fakeFetch("1024");
  const output=[];
  try{
    const result=await runPermissionPreflightCli({
      env:{
        DISCORD_AUTHORIZATION_PATH:f.path,
        DISCORD_BOT_TOKEN:"never-print-this",
        DISCORD_MESSAGE_CONTENT_INTENT_CONFIRMED:"true",
      },
      fetchImpl:fake.fetchImpl,write:value=>output.push(value),now,
    });
    assert.equal(result.result.ok,false);
    assert.equal(result.result.readyForGateway,false);
    assert.equal(result.exitCode,1);
    assert.ok(!output.join("\n").includes("never-print-this"));
  }finally{f.cleanup()}
});

test("standalone preflight rejects a missing token before making API requests",async()=>{
  const f=fixture();
  let calls=0;
  try{
    await assert.rejects(runPermissionPreflightCli({
      env:{DISCORD_AUTHORIZATION_PATH:f.path},
      fetchImpl:async()=>{calls++;return jsonResponse({})},
      now,
    }),/DISCORD_BOT_TOKEN is required/);
    assert.equal(calls,0);
  }finally{f.cleanup()}
});
