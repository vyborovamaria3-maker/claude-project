import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {
  emitVerifiedTgTokenLinkOutbox,
} from "../../src/persistence/outbox.js";
import {persistMessage} from "../../src/persistence/messages.js";

test("TG: verified mint link shares native PostgreSQL transaction and rolls back safely",{
  skip:!process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  await migrate();
  const tx=await pool.connect();
  const prevOut=process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
  const prevLink=process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
  const peer="123456789";
  const mint="So11111111111111111111111111111111111111112";
  const text="literal minted source "+mint;
  const identifier="tokenlink_test_"+randomUUID().replaceAll("-","").slice(0,20);
  let finished=false;
  try{
    process.env.TG_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    await tx.query("BEGIN");
    const src=await tx.query<{id:string}>(
      "INSERT INTO tg_sources(identifier,peer_id) VALUES($1,$2) RETURNING id::text",
      [identifier,peer],
    );
    const sourceId=src.rows[0]!.id;
    await persistMessage(tx,sourceId,{id:981,date:1792364400,message:text});
    const observedAt=new Date("2026-10-20T01:00:00Z");
    const postedAt=new Date("2026-10-19T22:00:00Z");
    const sourceRevisionSha256=createHash("sha256").update(JSON.stringify([
      text,postedAt.toISOString(),null,
    ])).digest("hex");
    const input={
      peerId:peer,messageId:"981",text,mint,
      tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      provider:"alchemy-solana-rpc" as const,
      sourceRevisionSha256,observedAt,postedAt,
    };
    assert.equal(await emitVerifiedTgTokenLinkOutbox(tx,input),true);
    assert.equal(await emitVerifiedTgTokenLinkOutbox(tx,input),true);
    const q=await tx.query<{n:string;payload:Record<string,unknown>}>(
      "SELECT COUNT(*)::text AS n FROM outbox_events WHERE event_kind='token_link_verified'",
    );
    assert.equal(q.rows[0]?.n,"1");
    await tx.query("ROLLBACK");finished=true;
    const absent=await tx.query<{n:string}>(
      "SELECT count(*)::text AS n FROM outbox_events WHERE event_key LIKE 'tg:tokenlink:tg:message:123456789:981:%'",
    );
    assert.equal(absent.rows[0]?.n,"0");
  }finally{
    if(!finished){try{await tx.query("ROLLBACK")}catch{}}
    if(prevOut===undefined)delete process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
    else process.env.TG_INTELLIGENCE_OUTBOX_ENABLED=prevOut;
    if(prevLink===undefined)delete process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED;
    else process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED=prevLink;
    tx.release();await pool.end();
  }
});
