import "dotenv/config";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import type {TelegramClient} from "telegram";
import {PROMO_SAMPLE_LIMIT} from "../../src/analytics/promo-spam.js";

function example(i:number) {
  return {id:20_000+i,date:1781049600+i,
    message:`#PNUT · VIP: x${(i+10)/10} ├ 🚀 Growth: x${i+2} ├ 📊 MC: $31.97K → $227.24K ⏱️1h └ 🟢 DEX PAID ⭐ Get VIP access ⭐`};
}
function ordinary(i:number) {
  return {id:10_000+i,date:1781049600+i,message:`Original Telegram research announcement ${i}`};
}

test("120-post preview blocks a repetitive paid-VIP channel before any history is saved",{
  skip:!process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {processJob}=await import("../../src/engines/channel.js");
  await migrate();
  const username="promo_"+randomUUID().replaceAll("-","").slice(0,12);
  const peer=String(Date.now())+"41";
  const id=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,current_username,peer_id,full_history)
    VALUES($1,$1,$2,TRUE) RETURNING id::text`,[username,peer])).rows[0].id;
  try{
    const job=(await pool.query(`
      INSERT INTO tg_jobs(source_id) VALUES($1) RETURNING *`,[id])).rows[0];
    const preview=[...Array.from({length:15},(_,i)=>example(i)),
      ...Array.from({length:105},(_,i)=>ordinary(i))];
    const calls:number[]=[];
    const client={
      async getEntity(){return {className:"Channel",username,id:{toString:()=>peer},title:"Promo fixture"};},
      async getMessages(_entity:unknown,opts:{limit:number}) {
        calls.push(opts.limit);
        if(opts.limit!==PROMO_SAMPLE_LIMIT) throw new Error("Forbidden: history fetched before spam decision");
        return preview;
      },
    } as unknown as TelegramClient;
    await processJob(client,job,()=>false);
    assert.deepEqual(calls,[120],"must perform one bounded preview and stop");
    const source=(await pool.query<{
      enabled:boolean;spam_kind:string|null;spam_sample_size:number;
      spam_match_count:number;spam_reason:string|null;spam_screened_at:Date|null;
    }>(`SELECT enabled,spam_kind,spam_sample_size,spam_match_count,spam_reason,spam_screened_at
      FROM tg_sources WHERE id=$1`,[id])).rows[0];
    assert.equal(source.enabled,false);
    assert.equal(source.spam_kind,"promotional_milestone");
    assert.equal(source.spam_sample_size,120);
    assert.equal(source.spam_match_count,15);
    assert.match(source.spam_reason??"",/PNUT/);
    assert.ok(source.spam_screened_at);
    const saved=(await pool.query<{n:number}>(`
      SELECT count(*)::int AS n FROM tg_messages WHERE source_id=$1`,[id])).rows[0].n;
    assert.equal(saved,0,"the preview is inspected, not persisted");
    const pending=(await pool.query<{state:string;last_error:string}>(`
      SELECT state,last_error FROM tg_jobs WHERE source_id=$1`,[id])).rows[0];
    assert.equal(pending.state,"failed");
    assert.equal(pending.last_error,"TG_SOURCE_SPAM_USELESS");
    await processJob(client,job,()=>false);
    assert.deepEqual(calls,[120],"blocked channel must not be fetched again");
  }finally{await pool.query("DELETE FROM tg_sources WHERE id=$1",[id]);}
});

test("one advertising post among 120 news posts does not block a real source",{
  skip:!process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {processJob}=await import("../../src/engines/channel.js");
  await migrate();
  const username="normal_"+randomUUID().replaceAll("-","").slice(0,12);
  const peer=String(Date.now())+"42";
  const id=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,current_username,peer_id,full_history)
    VALUES($1,$1,$2,FALSE) RETURNING id::text`,[username,peer])).rows[0].id;
  try{
    const job=(await pool.query(`
      INSERT INTO tg_jobs(source_id) VALUES($1) RETURNING *`,[id])).rows[0];
    const calls:number[]=[];
    const client={
      async getEntity(){return {className:"Channel",username,id:{toString:()=>peer},title:"News fixture"};},
      async getMessages(_entity:unknown,opts:{limit:number}) {
        calls.push(opts.limit);
        if(opts.limit===PROMO_SAMPLE_LIMIT)
          return [example(0),...Array.from({length:119},(_,i)=>ordinary(i))];
        // No new Telegram posts are available for this test source.
        return [];
      },
    } as unknown as TelegramClient;
    await processJob(client,job,()=>false);
    assert.deepEqual(calls,[120,1],"normal channel must proceed to its regular scan");
    const status=(await pool.query<{enabled:boolean;spam_kind:string|null;spam_match_count:number}>(`
      SELECT enabled,spam_kind,spam_match_count FROM tg_sources WHERE id=$1`,[id])).rows[0];
    assert.equal(status.enabled,true);
    assert.equal(status.spam_kind,null);
    assert.equal(status.spam_match_count,1);
  }finally{await pool.query("DELETE FROM tg_sources WHERE id=$1",[id]);}
});
