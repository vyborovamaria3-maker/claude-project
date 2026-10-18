import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encrypt, decrypt, rotateKey, retry, TransientError, PermanentError, RateLimitError,
  classifyError, exponentialBackoff, jitter, sanitizeForLog, createLogger, TokenBucket,
} from "../dist/index.js";

test("AES-GCM roundtrip, rotation, tamper rejection, key length", () => {
  const a = randomBytes(32), b = randomBytes(32);
  const encrypted = encrypt(a,"local proxy password");
  assert.notEqual(encrypted,"local proxy password");
  assert.equal(decrypt(a, encrypted),"local proxy password");
  assert.equal(decrypt(b,rotateKey(a,b,encrypted)),"local proxy password");
  assert.throws(()=>decrypt(b,encrypted));
  assert.throws(()=>encrypt(randomBytes(16),"secret"),/32-byte/);
  const components = encrypted.split(".");
  components[3] = Buffer.from("altered").toString("base64url");
  assert.throws(()=>decrypt(a,components.join(".")));
});

test("retry only transient/rate-limited failures and honor delay", async () => {
  let calls=0;
  const slept=[];
  const result=await retry(async () => {
    calls++;
    if(calls===1) throw new RateLimitError("slow down",500);
    if(calls===2) throw new TransientError("temporary");
    return 7;
  },{maxAttempts:4,baseDelayMs:10,maxDelayMs:100,jitterRatio:0,sleep:async ms=>{slept.push(ms)}});
  assert.equal(result,7);
  assert.deepEqual(slept,[500,20]);
  await assert.rejects(retry(async()=>{throw new PermanentError("bad")},{maxAttempts:5,baseDelayMs:1,maxDelayMs:10,sleep:async()=>{}}),PermanentError);
  assert.equal(classifyError(new Error("unknown")),"unknown");
  assert.equal(exponentialBackoff(4,10,80),80);
  assert.equal(jitter(100,0.5,()=>1),50);
});

test("redacted structured logging avoids nested credentials", () => {
  const lines=[];
  const log=createLogger("x-collector",s=>lines.push(s));
  log.info("fetch",{taskId:1,credentials:{password:"xxx",accessToken:"secret",ok:true},headers:{Authorization:"Bearer xyz"}});
  assert.equal(lines.length,1);
  assert.ok(!lines[0].includes("secret"));
  assert.ok(!lines[0].includes("Bearer"));
  assert.equal(JSON.parse(lines[0]).credentials.password,"[REDACTED]");
});

test("local bucket is bounded and never grants over capacity", () => {
  const bucket=new TokenBucket(1,2,0);
  assert.equal(bucket.tryAcquire(2,0),true);
  assert.equal(bucket.tryAcquire(1,0),false);
  assert.equal(bucket.tryAcquire(1,1000),true);
  assert.equal(bucket.tryAcquire(1,1000),false);
  assert.throws(()=>bucket.tryAcquire(3,1000),/Invalid token request/);
});
