import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTarget } from "../src/analytics/normalize.js";
import { extractLinks } from "../src/analytics/extract.js";

test("EVM address is canonical regardless of casing and refuses truncation", () => {
  const raw = "0x" + "aBcD".repeat(10);
  assert.equal(normalizeTarget("evm_address",raw), "0x"+"abcd".repeat(10));
  assert.equal(normalizeTarget("evm_address",raw.toLowerCase()),"0x"+"abcd".repeat(10));
  assert.equal(normalizeTarget("evm_address","0xabcd..."),null);
  assert.equal(normalizeTarget("evm_address","abcd".repeat(10)),null);
});

test("mentions and Telegram public post links map to same handle", () => {
  const variants = ["@AlphaCalls","alphacalls","https://t.me/ALPHACALLS/123",
    "t.me/alphacalls","https://telegram.me/alphacalls"];
  assert.deepEqual(variants.map(x=>normalizeTarget("handle",x)),
    Array(variants.length).fill("alphacalls"));
  assert.equal(normalizeTarget("handle","https://t.me/+invitehash"),null);
  assert.equal(normalizeTarget("handle","t.me/joinchat/code"),null);
  assert.equal(normalizeTarget("handle","evil.t.me/alphacalls"),null);
});

test("Solana base58 case must not be folded, and truncated values rejected", () => {
  const sol = "So11111111111111111111111111111111111111112";
  assert.equal(normalizeTarget("solana_address",sol),sol);
  assert.equal(normalizeTarget("solana_address",sol.slice(0,10)+"..."),null);
});
test("dedup per message for same canonical mention / address", () => {
  const evm = "0x" + "A".repeat(40);
  const output = extractLinks({id:1,message:`@AlphaCalls t.me/alphacalls ${evm} ${evm.toLowerCase()}`});
  assert.equal(output.filter(x=>x.targetKind==="handle").length,1);
  assert.equal(output.filter(x=>x.targetKind==="evm_address").length,1);
});
test("Bot API channel-forward adapter and anonymity semantics", () => {
  assert.deepEqual(extractLinks({id:1,message:"",forward_from_chat:{id:-10012345,type:"channel"}}),[
    {kind:"forward",targetKind:"channel_id",targetKey:"12345"}]);
  assert.deepEqual(extractLinks({id:2,message:"",forward_sender_name:"Hidden Sender",forward_from:{id:77}}),[]);
});
