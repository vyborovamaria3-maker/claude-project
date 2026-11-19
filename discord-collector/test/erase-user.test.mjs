import test from "node:test";
import assert from "node:assert/strict";
import {parseEraseUserArgs} from "../src/erase-user.mjs";

test("user erasure CLI requires an explicit author ID and confirmation",()=>{
  assert.throws(()=>parseEraseUserArgs([]),/explicit --confirm/);
  assert.throws(()=>parseEraseUserArgs(["--author-id","123456789012345678"]),/explicit --confirm/);
  assert.throws(()=>parseEraseUserArgs(["--author-id","123456789012345678","--confirm","--author-id","223456789012345678"]),/Exactly one/);
  assert.throws(()=>parseEraseUserArgs(["--author-id","123","--confirm"]),/Snowflake/);
  assert.deepEqual(parseEraseUserArgs(["--author-id","123456789012345678","--confirm"]),{
    authorId:"123456789012345678",confirm:true,
  });
});

test("help does not require database credentials",()=>{
  assert.deepEqual(parseEraseUserArgs(["--help"]),{help:true});
});
