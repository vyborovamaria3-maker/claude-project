import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {parseSnapshotEncryptionKey,sealEventText,unsealEventText,
  storeEncryptedEventText,readEncryptedEventText,purgeEncryptedEventText} from "../dist/index.js";

const id={sourceSystem:"tg",sourceEventKind:"message_observed",
  eventKey:"tg:-10022:42:rev:fake"};
test("AES-GCM payload is bound to exact event and cannot be decrypted after tampering",()=>{
  const key=parseSnapshotEncryptionKey(randomBytes(32).toString("base64"));
  const sealed=sealEventText(key,id,"Test Telegram revision");
  assert.ok(!sealed.ciphertext.includes(Buffer.from("Test Telegram revision")));
  assert.equal(unsealEventText(key,id,sealed.sha256,sealed.ciphertext),"Test Telegram revision");
  assert.throws(()=>unsealEventText(key,{...id,eventKey:"another-revision"},sealed.sha256,sealed.ciphertext));
  assert.throws(()=>unsealEventText(randomBytes(32),id,sealed.sha256,sealed.ciphertext));
  const tampered=Buffer.from(sealed.ciphertext);tampered[tampered.length-1]^=1;
  assert.throws(()=>unsealEventText(key,id,sealed.sha256,tampered));
});
test("text is never included as a literal SQL parameter",async()=>{
  const key=randomBytes(32);
  let params;
  const db={async query(sql,p){params=p;return {rows:[{event_key:"e"}]}}};
  assert.equal(await storeEncryptedEventText(db,{...id,observedAt:"2026-10-20T10:00:00Z",
    text:"Secret source post",key,keyRef:"runtime-v1"}),true);
  assert.ok(Buffer.isBuffer(params[5]));
  assert.equal(params.includes("Secret source post"),false);
  assert.ok(!JSON.stringify(params).includes("Secret source post"));
});
test("read refuses mismatched key reference and missing snapshot",async()=>{
  const key=randomBytes(32);
  const sealed=sealEventText(key,id,"some text");
  const db={async query(){return {rows:[{...sealed,revision_sha256:sealed.sha256,
    text_ciphertext:sealed.ciphertext,encryption_key_ref:"unexpected-ref"}]}}};
  await assert.rejects(readEncryptedEventText(db,key,{...id,keyRef:"runtime-v1"}),/ambiguous/);
  assert.equal(await readEncryptedEventText({async query(){return {rows:[]}}},key,
    {...id,keyRef:"runtime-v1"}),null);
});
test("purge returns deleted count without exposing ciphertext",async()=>{
  const db={async query(sql,params){
    assert.match(sql,/DELETE FROM event_text_snapshots/);assert.deepEqual(params,[3]);
    return {rows:[{event_key:"x"},{event_key:"y"}]};
  }};
  assert.equal(await purgeEncryptedEventText(db,3),2);
});
