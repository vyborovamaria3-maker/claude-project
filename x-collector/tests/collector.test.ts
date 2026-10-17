import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { extractTweetArticles } from '../lib/trade/twitter-scraper';
import { parseTweets as parseLegacyXTweets } from '../src/x/parser';
import { normalizeTweet } from '../src/x/normalize';
import { persistTweets, persistProfile } from '../lib/trade/collector-store';
import { closePool } from '../lib/trade/pg';
test('visible DOM collector keeps canonical ID, unknown counts, media-only posts and active controls', async()=>{
 const browser = await chromium.launch({ headless: true });
 try {
 const page=await browser.newPage();
 await page.setContent(`<article data-testid="tweet"><a href="/alice/status/1234567890123456789"><time datetime="2025-01-01T00:00:00Z"></time></a><div data-testid="tweetText">hello @bob #Solana</div><a href="/quoted/status/9999999999999999999">quote</a><button data-testid="unlike" aria-label="1.2K Likes"></button><button data-testid="unretweet" aria-label="1,234,567 Reposts"></button><button data-testid="reply" aria-label="0 Replies"></button><div data-testid="tweetPhoto"><img src="https://example.org/photo.jpg"></div></article><article data-testid="tweet"><a href="/alice/status/2234567890123456789"><time datetime="2025-01-01"></time></a><video poster="https://example.org/video.jpg"></video></article>`);
 const tweets=await page.locator('article').evaluateAll(extractTweetArticles);
 assert.equal(tweets.length,2); assert.equal(tweets[0].id,'1234567890123456789');
 assert.equal(tweets[0].retweets,1234567);assert.equal(tweets[0].likes,1200);assert.equal(tweets[0].replies,0);assert.equal(tweets[0].views,null);
 assert.deepEqual(tweets[0].mentions,['bob']);assert.deepEqual(tweets[0].relatedPostIds,['9999999999999999999']);
 assert.equal(tweets[1].text,'');assert.equal(tweets[1].media[0].type,'video');
 }finally{await browser.close();}
});
test('legacy X parser and normalizer preserve unknown metrics as NULL but retain known zero', async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const context=await browser.newContext();
  await context.addInitScript({content:["if (typeof globalThis.__name !== 'function') {","  globalThis.__name = function (target, value) {","    try { Object.defineProperty(target, 'name', { value: value, configurable: true }); } catch (e) {}","    return target;","  };","}"].join("\n")});
  const page=await context.newPage();
  await page.setContent(`<article><a href="/alice/status/1234567890123456789"><time datetime="2025-01-01T00:00:00Z"></time></a><div data-testid="tweetText">hello</div><button data-testid="reply">0 Replies</button></article>`);
  const tweets=await parseLegacyXTweets(page);
  assert.equal(tweets.length,1);
  assert.equal(tweets[0].likes,null);
  assert.equal(tweets[0].reposts,null);
  assert.equal(tweets[0].views,null);
  assert.equal(tweets[0].replies,0);
  const normalized=normalizeTweet(tweets[0]);
  assert(normalized);
  assert.equal(normalized.likes,null);
  assert.equal(normalized.retweets,null);
  assert.equal(normalized.views,null);
  assert.equal(normalized.replies,0);
 } finally { await browser.close(); }
});

test('collector writes nullable current metrics, decreasing observations, archive and profile history atomically',async()=>{
 const db=new PGlite(),root=await fs.mkdtemp(path.join(os.tmpdir(),'collector-'));
 const old={url:process.env.DATABASE_URL,root:process.env.ARCHIVE_RAW_DIR,reserve:process.env.ARCHIVE_MIN_FREE_GB};
 process.env.DATABASE_URL='postgresql://fixture/collector_test';process.env.ARCHIVE_RAW_DIR=root;process.env.ARCHIVE_MIN_FREE_GB='0';
 const query=async(sql:string,params:unknown[]=[])=>{const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};};
 const a=mock.method(Pool.prototype,'query',query),b=mock.method(Pool.prototype,'connect',async()=>({query,release(){},on(){}}));
 try{
for(const f of ['001_init.sql','005_nlp.sql','014_archive.sql','018_ai_foundation.sql','015_collector_observations.sql','023_intelligence_platform.sql','024_intelligence_temporal.sql','049_raw_retention_author_id.sql'])await db.exec(await fs.readFile('migrations/'+f,'utf8'));

await db.exec(`
CREATE TABLE IF NOT EXISTS tweet_entities (
  tweet_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence NUMERIC DEFAULT 1,
  PRIMARY KEY(tweet_id, entity_type, value)
);
`);
 const base={id:'1234567890123456789',text:'Solana',mentions:['Bob'],relatedPostIds:['9999999999999999999'],authorHandle:'alice',authorDisplayName:null,url:'https://x.com/alice/status/1234567890123456789',views:null,likes:5,retweets:null,replies:0,isVerified:false,postedAt:Date.parse('2025-01-01')};
 await persistTweets(null,[{...base,observedAt:Date.parse('2025-01-02')}]);
 await persistTweets(null,[{...base,likes:2,observedAt:Date.parse('2025-01-03')}]);
 const current=(await db.query<{likes:number;views:null}>('SELECT * FROM twitter_tweets')).rows[0];assert.equal(current.views,null);assert.equal(current.likes,2);
 assert.equal((await db.query('SELECT * FROM twitter_tweet_observations')).rows.length,2);
 assert.equal((await db.query('SELECT * FROM archive_metrics')).rows.length,2);
 assert.equal((await db.query('SELECT * FROM twitter_entity_links')).rows.length,2);
 await persistTweets(null,[{...base,likes:1,observedAt:Date.parse('2025-01-01')}]);
 assert.equal((await db.query<{likes:number}>('SELECT likes FROM twitter_tweets')).rows[0].likes,2);
  await persistTweets(null,[{...base,id:'3234567890123456789',observedAt:Date.parse('2024-12-31')}]);
  assert.equal((await db.query("SELECT * FROM twitter_tweets WHERE tweet_id='3234567890123456789'")).rows.length,1);
 await persistTweets(null,[],null,undefined,undefined,undefined,{rawResponse:{data:[{malformed:true}]}});
 const rawEmpty=(await db.query<{response_status:string;parse_status:string}>("SELECT response_status,parse_status FROM archive_raw_pages ORDER BY received_at DESC LIMIT 1")).rows[0];
 assert.equal(rawEmpty.response_status,'unknown');
 assert.equal(rawEmpty.parse_status,'parsed');
 await assert.rejects(persistTweets(null,[{...base,id:'bad'}]),/malformed/);
 const profile={handle:'alice',displayName:'Alice',bio:null,followers:10,following:null,postsCount:null,isVerified:false,joinedAt:null,avatarUrl:null};
 await persistProfile(profile);assert.equal((await db.query('SELECT * FROM twitter_profile_observations')).rows.length,1);
 }finally{await closePool();a.mock.restore();b.mock.restore();await db.close();await fs.rm(root,{recursive:true,force:true});for(const [key,value] of Object.entries({DATABASE_URL:old.url,ARCHIVE_RAW_DIR:old.root,ARCHIVE_MIN_FREE_GB:old.reserve})){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});


