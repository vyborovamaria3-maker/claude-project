import { test } from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_VERSION, extractLinks, isSolanaAddress } from "../src/analytics/extract.js";

const sol = "So11111111111111111111111111111111111111112";
const evm = "0x" + "aB".repeat(20);

test("v5 emits only validated Solana address links and deduplicates mentions", () => {
  assert.equal(ANALYSIS_VERSION, 5);
  assert.equal(isSolanaAddress(sol), true);
  assert.equal(isSolanaAddress("1".repeat(40)), false);
  const edges = extractLinks({ id: 1, message: `@AlphaCalls https://t.me/alphacalls calls ${sol} ${sol} ${evm} ${evm}` });
  assert.deepEqual(edges.filter(e=>e.targetKind==="handle").map(e=>e.targetKey), ["alphacalls"]);
  assert.deepEqual(edges.filter(e=>e.kind==="address").map(e=>e.targetKind), ["solana_address"]);
  assert.equal(edges.filter(e=>e.targetKind==="solana_address").length, 1);
});

test("only verified PeerChannel forwarding creates direct forward edge", () => {
  assert.deepEqual(extractLinks({id:10,message:"",fwdFrom:{fromName:"Not Verified"}}),[]);
  assert.deepEqual(extractLinks({id:11,message:"",fwdFrom:{fromId:{className:"PeerUser",channelId:{toString:()=>"23"}}}}),[]);
  assert.deepEqual(extractLinks({id:12,message:"",fwdFrom:{fromId:{className:"PeerChannel",channelId:{toString:()=>"23"}}}}),[
    {kind:"forward",targetKind:"channel_id",targetKey:"23"}
  ]);
});

test("ignores private invite links and misleading addresses", () => {
  const edges = extractLinks({id:99,message:"https://t.me/joinchat/xxx @user https://t.me/alpha_group invalidSolana1111111111111111111111111111111"});
  assert.deepEqual(edges.filter(e=>e.targetKind==="handle").map(e=>e.targetKey), ["alpha_group"]);
});

test("empty content and repeated links do not produce invented relationships", () => {
  assert.deepEqual(extractLinks({id:1}),[]);
  assert.deepEqual(extractLinks({id:2,message:"https://t.me/teamalpha https://t.me/teamalpha"}),[
    {kind:"mention",targetKind:"handle",targetKey:"teamalpha"}
  ]);
});

test("does not treat lookalike hostnames as public Telegram references", () => {
  const edges = extractLinks({ id: 50, message: "https://evil.t.me/notreal https://t.me/realchannel" });
  assert.deepEqual(edges.filter(e => e.targetKind === "handle").map(e => e.targetKey), ["realchannel"]);
});
