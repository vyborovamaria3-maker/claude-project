import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const load=createRequire(__filename);
const reconciliation=load('../scripts/autopost/reconciliation.cjs');
const {findMatches,decideReconciliation,expandTweetUrls,nextCheckDelayMs,nextCheckAt,RECONCILIATION_WINDOW_MS}=reconciliation;

function job(overrides:Record<string,unknown>={}) {
  return {
    id:'00000000-0000-4000-8000-000000000001',
    account_name:'publisher',
    expected_handle:'publisher',
    kind:'post',
    content:'Read the research first. https://x.com/i/status/123',
    origin:'agent',
    attempted_at:1_800_000_000_000,
    created_at:1_800_000_000_000,
    ...overrides,
  };
}

function candidate(id:string,overrides:Record<string,unknown>={}) {
  return {
    tweet_id:id,
    handle:'publisher',
    text:'Read the research first. https://x.com/i/status/123',
    posted_at:1_800_000_005_000,
    ...overrides,
  };
}

test('contradictory X action controls are unknown, never confirmed success',()=>{
 const {classifyActionState}=reconciliation;
 for(const kind of ['like','repost','follow']){
  assert.equal(classifyActionState(kind,true,true),'unknown');
  assert.equal(classifyActionState(kind,true,false),'performed');
  assert.equal(classifyActionState(kind,false,true),'not_performed');
  assert.equal(classifyActionState(kind,false,false),'unknown');
 }
});

test('reconciliation requires an exact author, text, and a timestamp near the send boundary',()=>{
  const now=1_800_000_010_000;
  const source=job();
  const matches=findMatches(source,[
    candidate('1234567890123456789'),
    candidate('1234567890123456790',{handle:'someone_else'}),
    candidate('1234567890123456791',{posted_at:source.attempted_at-60*1000}),
    candidate('1234567890123456792',{text:'Different post'}),
    candidate('1234567890123456793',{text:'Read the research first. https://x.com/i/status/999'}),
  ],now);
  assert.equal(matches.length,1);
  assert.equal(matches[0].tweet_id,'1234567890123456789');
  const lateDuplicate=findMatches(source,[candidate('1234567890123456794',{posted_at:source.attempted_at+6*60*1000})],source.attempted_at+60*60*1000);
  assert.equal(lateDuplicate.length,0,'a later identical post must not confirm the original send');
});

test('reply reconciliation requires the same parent tweet ID',()=>{
  const source=job({kind:'reply',target_id:'555'});
  const {extractTimelineTweets}=load('../scripts/autopost/browser.cjs');
  const timeline={data:{tweet:{rest_id:'1234567890123456789',legacy:{full_text:source.content,created_at:new Date(source.attempted_at+5000).toISOString(),in_reply_to_status_id_str:'555'},core:{user_results:{result:{legacy:{screen_name:'publisher'}}}}}}};
  const extracted=extractTimelineTweets(timeline);
  assert.equal(extracted[0].in_reply_to_tweet_id,'555');
  assert.equal(findMatches(source,extracted,source.attempted_at+10000).length,1);
  assert.equal(findMatches(source,[{...extracted[0],tweet_id:'1234567890123456790',in_reply_to_tweet_id:'999'}],source.attempted_at+10000).length,0);
});

test('short links are expanded before matching and a different source permalink is not a match',()=>{
  const expanded=expandTweetUrls({full_text:'Read the research first. https://t.co/short',entities:{urls:[{url:'https://t.co/short',expanded_url:'https://twitter.com/i/status/123'}]}});
  assert.equal(expanded,'Read the research first. https://twitter.com/i/status/123');
  const now=1_800_000_010_000;
  assert.equal(findMatches(job(),[candidate('1234567890123456789',{text:expanded})],now).length,1);
  assert.equal(findMatches(job(),[candidate('1234567890123456793',{text:'Read the research first. https://x.com/i/status/999'})],now).length,0);
});

test('manual confirmation records the correct destination for likes, reposts, and follows',()=>{
  const {manualConfirmationResult}=load('../scripts/autopost/engine.cjs');
  assert.throws(()=>manualConfirmationResult({kind:'post',expected_handle:'publisher'},'not-a-tweet-id'),/Некорректный ID твита/);
  assert.deepEqual(manualConfirmationResult({kind:'like',target_handle:'source',target_id:'123'},null),{resultId:null,resultUrl:'https://x.com/source/status/123'});
  assert.deepEqual(manualConfirmationResult({kind:'repost',target_handle:'source',target_id:'456'},null),{resultId:null,resultUrl:'https://x.com/source/status/456'});
  assert.deepEqual(manualConfirmationResult({kind:'follow',target_handle:'source',target_id:'456'},null),{resultId:null,resultUrl:'https://x.com/source'});
});

test('manual confirmation may select an ID outside the candidate list only after explicit operator confirmation',()=>{
  const {selectManualCandidate}=load('../scripts/autopost/engine.cjs');
  const candidates=[{tweet_id:'1234567890123456789'}];
  assert.throws(()=>selectManualCandidate(candidates,'1234567890123456799',false),/Выберите/);
  assert.deepEqual(selectManualCandidate(candidates,'1234567890123456799',true),{});
  assert.equal(selectManualCandidate(candidates,'1234567890123456789',false).tweet_id,'1234567890123456789');
});

test('action reconciliation only confirms positive UI evidence',()=>{
  assert.equal(reconciliation.classifyActionState('like',true,false),'performed');
  assert.equal(reconciliation.classifyActionState('repost',false,true),'not_performed');
  assert.equal(reconciliation.classifyActionState('follow',false,false),'unknown');
  assert.equal(reconciliation.classifyActionState('post',true,false),'unsupported');
});
test('one exact match resolves, multiple exact matches require manual review',()=>{
  const now=1_800_000_010_000;
  const source=job();
  const one=findMatches(source,[candidate('1234567890123456789')],now);
  assert.equal(decideReconciliation({kind:'post',matches:one,now,deadlineAt:now+RECONCILIATION_WINDOW_MS}).status,'resolved');
  const two=findMatches(source,[candidate('1234567890123456789'),candidate('1234567890123456790',{posted_at:1_800_000_006_000})],now);
  assert.equal(two.length,2);
  assert.equal(decideReconciliation({kind:'post',matches:two,now,deadlineAt:now+RECONCILIATION_WINDOW_MS}).status,'manual_review');
});

test('no match retries only within the 24-hour window and never schedules beyond the deadline',()=>{
  const now=1_800_000_010_000;
  assert.equal(decideReconciliation({kind:'reply',matches:[],now,deadlineAt:now+RECONCILIATION_WINDOW_MS}).status,'retry');
  assert.equal(decideReconciliation({kind:'reply',matches:[],now:now+RECONCILIATION_WINDOW_MS,deadlineAt:now+RECONCILIATION_WINDOW_MS}).status,'manual_required');
  assert.equal(nextCheckDelayMs(1),5*60*1000);
  assert.equal(nextCheckDelayMs(2),15*60*1000);
  assert.equal(nextCheckAt(now,1,now+1000),now+1000);
});

test('unsupported action kinds are escalated instead of being automatically retried',()=>{
  const now=1_800_000_010_000;
  assert.equal(decideReconciliation({kind:'like',matches:[],now,deadlineAt:now+RECONCILIATION_WINDOW_MS}).status,'manual_review');
});

test('reconciliation schema keeps UUID job IDs as TEXT and can be applied by the existing setup script',()=>{
  const schema=readFileSync('scripts/autopost/schema.sql','utf8');
  assert.match(schema,/CREATE TABLE IF NOT EXISTS xc_auto_reconcile\s*\([\s\S]*?job_id text PRIMARY KEY REFERENCES xc_auto_jobs\(id\) ON DELETE CASCADE/i);
  assert.match(schema,/CREATE INDEX IF NOT EXISTS xc_auto_reconcile_due/);
});