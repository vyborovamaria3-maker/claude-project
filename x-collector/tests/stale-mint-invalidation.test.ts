import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";

/** This reproduces the PostgreSQL guard used by collector-store, not a
 * browser/XActions request. The returned rows are the only safe tombstone
 * candidates; raw input rows may have been rejected by the upsert.
 */
test("replayed old X observation cannot generate mint invalidation",async()=>{
  const store=await readFile(
    "src/collector/persistence/collector-store.ts","utf8");
  assert.match(store,/WHERE EXCLUDED\.updated_at >= twitter_tweets\.updated_at\s+RETURNING tweet_id/);
  assert.match(store,/genuinelyWrittenIds\.has\(t\.id\)/);
  const db=new PGlite();
  try{
    await db.exec("CREATE TABLE twitter_tweets(tweet_id TEXT PRIMARY KEY,updated_at BIGINT,text TEXT)");
    await db.query("INSERT INTO twitter_tweets VALUES('100',300,'new verified revision')");
    const save=async(time:number,text:string)=>db.query<{tweet_id:string}>(
      "INSERT INTO twitter_tweets(tweet_id,updated_at,text) VALUES($1,$2,$3) " +
      "ON CONFLICT(tweet_id) DO UPDATE SET updated_at=EXCLUDED.updated_at,text=EXCLUDED.text " +
      "WHERE EXCLUDED.updated_at>=twitter_tweets.updated_at RETURNING tweet_id",
      ["100",time,text],
    );
    const stale=await save(200,"old text without mint");
    assert.equal(stale.rows.length,0);
    assert.equal(stale.rows.some(row=>row.tweet_id==="100"),false,
      "stale text must not be published as an edit");
    assert.equal((await db.query<{text:string}>(
      "SELECT text FROM twitter_tweets WHERE tweet_id='100'")).rows[0]?.text,
      "new verified revision");
    const fresh=await save(400,"actually newer revision");
    assert.deepEqual(fresh.rows.map(row=>row.tweet_id),["100"]);
  }finally{await db.close()}
});
