process.env.TG_PROMOTIONAL_SCREENING_ENABLED="true";
import "dotenv/config";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import type {TelegramClient} from "telegram";

const ad=(id:number)=>({
  id,date:1791650000+id,
  message:`#PNUT · VIP: x${id}.9 ├ 🚀 Growth: x${id} ├ 📊 MC: $31.97K → $${100+id}.24K ⏱️1h └ 🟢 DEX PAID ⭐ Get VIP access ⭐`,
});
const news=(id:number)=>({id,date:1791650000+id,message:`Noncommercial news post ${id}`});

test("source preflight: stop before writing history and quarantine 15 PNUT promo alerts in last 120 posts",{
  skip:!process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {processJob}=await import("../../src/engines/channel.js");
  await migrate();
  const handle="vip_spam_"+randomUUID().replaceAll("-","").slice(0,12);
  const peer="915"+Math.floor(Math.random()*1e12).toString().padStart(12,"0");
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,peer_id,full_history,history_partial)
    VALUES($1,$2,TRUE,TRUE) RETURNING id::text`,[handle,peer])).rows[0].id;
  let entityCalls=0,fetches=0;
  try{
    const job=(await pool.query(`INSERT INTO tg_jobs(source_id) VALUES($1) RETURNING *`,[source])).rows[0];
    const sample=[...Array.from({length:15},(_,i)=>ad(i+1)),
      ...Array.from({length:105},(_,i)=>news(i+20))];
    const mock={
      async getEntity(){
        entityCalls++;
        return {className:"Channel",id:{toString:()=>peer},
          username:handle,title:"VIP repetitive promo",accessHash:{toString:()=> "4"}};
      },
      async getMessages(_entity:unknown,opts:{limit:number}){
        fetches++;
        assert.equal(opts.limit,120,"a spam channel must never proceed to history pages");
        return sample;
      },
    } as unknown as TelegramClient;
    await processJob(mock,job,()=>false);
    assert.equal(fetches,1);
    const status=(await pool.query<{
      enabled:boolean;spam_kind:string|null;spam_match_count:number;spam_sample_size:number;
      spam_reason:string|null;spam_screened_at:Date|null;
    }>(`SELECT enabled,spam_kind,spam_match_count,spam_sample_size,spam_reason,spam_screened_at
      FROM tg_sources WHERE id=$1`,[source])).rows[0];
    assert.equal(status.enabled,false);
    assert.equal(status.spam_kind,"promotional_milestone");
    assert.equal(status.spam_match_count,15);
    assert.equal(status.spam_sample_size,120);
    assert.match(status.spam_reason??"",/PNUT/);
    assert.ok(status.spam_screened_at);
    const currentJob=(await pool.query<{state:string;last_error:string|null}>(`
      SELECT state,last_error FROM tg_jobs WHERE source_id=$1`,[source])).rows[0];
    assert.deepEqual(currentJob,{state:"failed",last_error:"TG_SOURCE_SPAM_USELESS"});
    const count=(await pool.query<{n:number}>(`
      SELECT count(*)::int AS n FROM tg_messages WHERE source_id=$1`,[source])).rows[0].n;
    assert.equal(count,0,"preview must not persist paid-VIP spam into the canonical archive");

    // Even an accidental caller retry must not fetch another Telegram page.
    await processJob(mock,job,()=>false);
    assert.equal(entityCalls,1);
    assert.equal(fetches,1);
  }finally{await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);}
});

test("source preflight: one milestone ad among 120 normal posts is not blocked",{
  skip:!process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {processJob}=await import("../../src/engines/channel.js");
  await migrate();
  const handle="mixed_"+randomUUID().replaceAll("-","").slice(0,13);
  const peer="916"+Math.floor(Math.random()*1e12).toString().padStart(12,"0");
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,peer_id)
    VALUES($1,$2) RETURNING id::text`,[handle,peer])).rows[0].id;
  const fetchLimits:number[]=[];
  try{
    const job=(await pool.query(`INSERT INTO tg_jobs(source_id) VALUES($1) RETURNING *`,[source])).rows[0];
    const client={
      async getEntity(){return {className:"Channel",id:{toString:()=>peer},
        username:handle,accessHash:{toString:()=> "2"},title:"Legitimate mixed source"};},
      async getMessages(_entity:unknown,opts:{limit:number}){
        fetchLimits.push(opts.limit);
        return opts.limit===120?[ad(4),...Array.from({length:119},(_,i)=>news(i+10))]:[];
      },
    } as unknown as TelegramClient;
    await processJob(client,job,()=>false);
    assert.deepEqual(fetchLimits.slice(0,2),[120,1],
      "nonspam source must continue into normal collection");
    const sourceRow=(await pool.query<{
      enabled:boolean;spam_kind:string|null;spam_sample_size:number;spam_match_count:number;spam_screened_at:Date|null;
    }>(`SELECT enabled,spam_kind,spam_sample_size,spam_match_count,spam_screened_at
      FROM tg_sources WHERE id=$1`,[source])).rows[0];
    assert.equal(sourceRow.enabled,true);
    assert.equal(sourceRow.spam_kind,null);
    assert.equal(sourceRow.spam_sample_size,120);
    assert.equal(sourceRow.spam_match_count,1);
    assert.ok(sourceRow.spam_screened_at);
    const jobState=(await pool.query<{state:string}>(`
      SELECT state FROM tg_jobs WHERE source_id=$1`,[source])).rows[0];
    assert.equal(jobState.state,"pending");
  }finally{await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);}
});
