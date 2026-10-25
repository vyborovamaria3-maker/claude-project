import test from "node:test";
import assert from "node:assert/strict";
import {formatTokenId} from "@claude-project/contracts";
import {
  parseLocalTokenArgs,assertLocalDestination,makeLocalReport,
} from "../scripts/local-token-report.mjs";
import {composeLocalTokenReport,formatLocalTokenReport} from "../scripts/local-token-report-core.mjs";

const mint="So11111111111111111111111111111111111111112";
const id=formatTokenId("solana",mint);
const knownAt="2026-10-21T03:00:00.000Z";
const occurredBefore="2026-10-20T23:00:00.000Z";
const now=new Date("2026-10-22T00:00:00.000Z");
const args=["--mint",mint,"--known-at",knownAt,"--occurred-before",occurredBefore];

test("CLI validates canonical mint and explicit UTC as-of boundaries",()=>{
  const x=parseLocalTokenArgs(args,now);
  assert.equal(x.tokenId,id);
  assert.equal(x.limit,20);
  assert.equal(parseLocalTokenArgs(["--mint",id,"--demo","--json"],now).demo,true);
  for(const bad of [
    [],["--mint","not_a_mint"],["--mint","solana:invalid"],
    [...args,"--known-at",knownAt],[...args,"--limit","0"],
    [...args,"--limit","101"],[...args,"--limit","1.5"],
    ["--mint",mint,"--known-at","2026-12-01T00:00:00Z"],
    ["--mint",mint,"--known-at",knownAt,"--occurred-before","2026-10-21T04:00:00Z"],
    ["--mint",mint,"--wrong"],
  ])assert.throws(()=>parseLocalTokenArgs(bad,now));
});

test("only explicitly opted-in loopback PostgreSQL destinations may be queried",()=>{
  assert.throws(()=>assertLocalDestination({}));
  assert.throws(()=>assertLocalDestination({INTELLIGENCE_LOCAL_READ_ENABLED:"1"}));
  for(const url of [
    "postgresql://prod.company.internal/secret",
    "postgresql://host.docker.internal/test",
    "postgresql://localhost/test?host=prod",
    "file:///tmp/my.db",
    "postgresql://localhost/",
    "postgresql://localhost/test#something",
  ])assert.throws(()=>assertLocalDestination({
    INTELLIGENCE_LOCAL_READ_ENABLED:"true",INTELLIGENCE_DATABASE_URL:url,
  }),/loopback_postgres_only/);
  assert.equal(assertLocalDestination({
    INTELLIGENCE_LOCAL_READ_ENABLED:"true",
    INTELLIGENCE_DATABASE_URL:"postgresql://localhost:5432/intelligence_test",
  }),"postgresql://localhost:5432/intelligence_test");
});

test("synthetic demo requires neither provider, database nor HTTP listener",async()=>{
  const options=parseLocalTokenArgs([...args,"--demo","--json"],now);
  const report=await makeLocalReport(options,{
    env:{},now,makePool(){throw new Error("database must never open")},
  });
  assert.equal(report.mode,"SYNTHETIC_FIXTURE_NO_DATABASE");
  assert.equal(report.syntheticFixture,true);
  assert.deepEqual(report.sampleCounts,{
    xVerifiedLinks:1,tgVerifiedLinks:1,
    providerParsedBlockchainSwaps:1,genericTimelineEvents:0,
  });
  assert.equal(report.interpretation.ai,"not_run_no_external_model");
  assert.equal(report.interpretation.pnl,"not_available");
  assert.equal(report.historicalCompleteness,"unknown");
  assert.match(formatLocalTokenReport(report),/LOCAL, OBSERVED EVIDENCE ONLY/);
  assert.match(formatLocalTokenReport(report),/finality NOT VERIFIED/);
});

function envelope(options){
  return {
    schemaVersion:"token-intelligence-v1",tokenId:options.tokenId,
    knownAt:options.knownAt,occurredBefore:options.occurredBefore,
    coverage:"observed_and_qualified_events_only",
    historicalCompleteness:"unknown",truncated:false,
  };
}
function payload(options){
  const at="2026-10-20T20:00:00.000Z";
  const observed="2026-10-21T02:00:00.000Z";
  return {
    evidence:{
      ...envelope(options),sourceScope:"separate_social_and_chain_evidence",
      independentLimitPerSourceType:options.limit,
      blockchainFinality:"not_independently_verified",
      tradeStatus:"not_a_confirmed_trade_tape",
      socialLinksTruncated:false,blockchainSwapEvidenceTruncated:false,
      socialLinks:[{
        source:"tg",evidenceId:"tg:message:-100123:42",
        occurredAt:at,observedAt:observed,
        verification:"source_verified_spl_mint_account",
        payload:"SECRET Telegram message",apiKey:"SECRET",
      }],
      blockchainSwapEvidence:[{
        source:"blockchain",evidenceId:"chain:tx:solana:abcdef",
        occurredAt:at,observedAt:observed,
        attribution:"provider_parsed_wallet_swap",
        finality:"not_independently_verified",tradeCompleteness:"unknown",
        signature:"SECRET raw transaction",wallet:"SECRET wallet",
      }],
    },
    timeline:{
      ...envelope(options),items:[{
        source:"x",kind:"tweet_published",evidenceId:"x:tweet:123",
        occurredAt:at,observedAt:observed,rawText:"SECRET tweet",
      }],
    },
  };
}
test("report never leaks source payloads and keeps chain separate from verified social",()=>{
  const options=parseLocalTokenArgs(args,now);
  const sample=payload(options);
  const report=composeLocalTokenReport(options,sample.evidence,sample.timeline);
  const json=JSON.stringify(report);
  assert.equal(report.syntheticFixture,undefined);
  assert.equal(report.sampleCounts.xVerifiedLinks,0);
  assert.equal(report.sampleCounts.tgVerifiedLinks,1);
  assert.equal(report.sampleCounts.providerParsedBlockchainSwaps,1);
  assert.equal(report.sampleCounts.genericTimelineEvents,1);
  assert.equal(report.blockchainSwapEvidence[0].finality,"not_independently_verified");
  assert.ok(!json.includes("SECRET"));
  assert.ok(!json.includes("SECRET wallet"));
  assert.equal(report.interpretation.missingIsNotZero,true);
  assert.ok(!formatLocalTokenReport(report).includes("SECRET"));
});

test("bad as-of, wrong mint, unverified sources and unexpected pagination fail closed",()=>{
  const options=parseLocalTokenArgs(args,now);
  const cases=[
    s=>{s.evidence.tokenId="solana:WRONG"},
    s=>{s.timeline.knownAt="2026-10-19T00:00:00.000Z"},
    s=>{s.evidence.socialLinks[0].verification="ticker_guess"},
    s=>{s.evidence.socialLinks[0].observedAt="2026-10-21T05:00:00.000Z"},
    s=>{s.evidence.blockchainSwapEvidence[0].finality="finalized"},
    s=>{s.evidence.blockchainSwapEvidence[0].tradeCompleteness="confirmed"},
    s=>{s.evidence.socialLinksTruncated="false"},
    s=>{s.timeline.items[0].occurredAt="2026-10-21T05:00:00.000Z"},
  ];
  for(const change of cases){
    const p=payload(options);change(p);
    assert.throws(()=>composeLocalTokenReport(options,p.evidence,p.timeline));
  }
});

test("read-only repeatable-read transaction is shared by both evidence queries",async()=>{
  const options=parseLocalTokenArgs(args,now);
  const calls=[];let closed=false,released=false;
  const at=new Date("2026-10-20T20:00:00.000Z");
  const observed=new Date("2026-10-21T02:00:00.000Z");
  const client={
    async query(sql,params){
      calls.push({sql,params});
      if(sql==="BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"||
         sql==="COMMIT"||sql==="ROLLBACK")return {rows:[]};
      if(sql.includes("to_regclass("))return {rows:[{
        inbox:true,timeline:true,entities:true,links:true,swap_revisions:true,
      }]};
      if(sql.includes("FROM blockchain_swap_evidence_revisions"))
        return {rows:[]};
      if(sql.includes("FROM token_link_observations"))return {rows:[{
        source_system:"x",evidence_source_id:"x:tweet:123",
        canonical_token_id:id,occurred_at:at,observed_at:observed,
        payload:"SECRET",
      }]};
      if(sql.includes("FROM timeline_events"))return {rows:[]};
      throw new Error("unexpected query in local report fixture");
    },
    release(){released=true},
  };
  const report=await makeLocalReport(options,{
    now,env:{
      INTELLIGENCE_LOCAL_READ_ENABLED:"true",
      INTELLIGENCE_DATABASE_URL:"postgresql://127.0.0.1/intelligence_test",
    },
    makePool(cfg){
      assert.match(cfg.options,/default_transaction_read_only=on/);
      assert.equal(cfg.max,1);
      return {connect:async()=>client,end:async()=>{closed=true}};
    },
  });
  assert.equal(calls[0].sql,"BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(calls.at(-1).sql,"COMMIT");
  assert.equal(report.syntheticFixture,false);
  assert.equal(report.sampleCounts.xVerifiedLinks,1);
  assert.equal(report.sampleCounts.providerParsedBlockchainSwaps,0);
  assert.equal(released,true);
  assert.equal(closed,true);
  assert.equal(calls.filter(x=>x.sql.includes("FROM timeline_events")).length,1);
  assert.ok(!JSON.stringify(report).includes("SECRET"));
});

test("failed schema readiness aborts transaction and releases local PG client",async()=>{
  const options=parseLocalTokenArgs(args,now);
  const calls=[];let released=false,closed=false;
  await assert.rejects(()=>makeLocalReport(options,{
    now,env:{
      INTELLIGENCE_LOCAL_READ_ENABLED:"true",
      INTELLIGENCE_DATABASE_URL:"postgresql://localhost/intelligence_test",
    },
    makePool:()=>({
      connect:async()=>({
        query:async sql=>{
          calls.push(sql);
          if(sql.includes("to_regclass("))return {rows:[{
            inbox:true,timeline:true,entities:true,links:false,swap_revisions:true,
          }]};
          return {rows:[]};
        },
        release:()=>{released=true},
      }),
      end:async()=>{closed=true},
    }),
  }),/migrations/);
  assert.equal(calls.at(-1),"ROLLBACK");
  assert.equal(released,true);assert.equal(closed,true);
});
