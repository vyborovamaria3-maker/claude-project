import assert from "node:assert/strict";
import { test } from "node:test";
import { publicDiscoveryChannel, verifiedPublicUsername } from "../src/validation.js";

test("active Telegram username aliases count as verified public handles", () => {
  const channel = {
    className: "Channel", broadcast: true, title: "Public fixture",
    id: {toString: () => "1234567890"},
    usernames: [
      {username:"old_alias",active:false},
      {username:"ActivePublic",active:true},
    ],
  };
  assert.equal(verifiedPublicUsername(channel),"activepublic");
  assert.deepEqual(publicDiscoveryChannel(channel), {
    peer:"1234567890",username:"activepublic",title:"Public fixture",
  });
});

test("private, inactive and malformed Telegram handles never authorize collection", () => {
  assert.equal(verifiedPublicUsername({usernames:[{username:"inactive_",active:false}]}),null);
  assert.equal(verifiedPublicUsername({username:"invalid handle",usernames:[{username:"valid_alias",active:false}]}),null);
  assert.equal(verifiedPublicUsername({username:"old alias",usernames:[{username:"valid_alias",active:true}]}),"valid_alias");
  assert.equal(publicDiscoveryChannel({
    className:"Channel",megagroup:true,id:{toString:()=> "123456"},
    usernames:[{username:"not_active",active:false}],
  }),null);
});
