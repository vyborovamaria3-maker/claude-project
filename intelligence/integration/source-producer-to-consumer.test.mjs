import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import pg from "pg";
import Database from "better-sqlite3";

import {
  verifyXTokenLinksOnce,parseMintVerificationArgs,
} from "../../x-collector/scripts/verify-x-token-links.ts";
import {
  verifySolanaMintViaAlchemy,TOKEN_PROGRAM as X_TOKEN_PROGRAM,
} from "../../x-collector/src/collector/persistence/solana-mint-proof.ts";
import {
  emitXVerifiedTokenLinkOutbox,emitXTokenLinksInvalidation,
} from "../../x-collector/src/collector/persistence/verified-token-links.ts";
import {
  readMintAccount,TOKEN_PROGRAM as TG_TOKEN_PROGRAM,
} from "../../tg-collector/src/analytics/solana-mint-rpc.ts";
import {
  emitVerifiedTgTokenLinkOutbox,emitTgTokenLinksInvalidation,
} from "../../tg-collector/src/persistence/outbox.ts";

import {
  POSTGRES_OUTBOX_DDL,SQLITE_OUTBOX_DDL,
  claimPostgres,ackPostgres,failPostgres,
  claimSqlite,ackSqlite,failSqlite,
} from "@claude-project/event-outbox";
import {
  runDeliveryBatch,queryActiveTokenLinks,queryActiveBlockchainSwapEvidence,
  queryTokenTimeline,
} from "../dist/index.js";

const require=createRequire(import.meta.url);
const {
  emitTokenSwapRevisionOutbox,
}=require("../../solana-launcher/scripts/blockchain-token-swap-revisions.cjs");

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const token="solana:"+mint;
const wallet="1".repeat(32);
const signature="1".repeat(64);

function rpcStub(owner,program){
  return async(endpoint,init)=>{
    assert.equal(new URL(endpoint).protocol,"https:");
    assert.equal(init?.method,"POST");
    const request=JSON.parse(String(init?.body));
    assert.equal(request.method,"getAccountInfo");
    assert.equal(request.params[0],mint);
    assert.equal(request.params[1].encoding,"jsonParsed");
    return new Response(JSON.stringify({
      jsonrpc:"2.0",id:1,
      result:{
        context:{slot:321000000},
        value:{
          owner,executable:false,
          data:{program,parsed:{type:"mint",info:{isInitialized:true,decimals:6}}},
        },
      },
    }),{status:200});
  };
}

const portPg=pool=>({
  claim:options=>claimPostgres(pool,options),
  ack:event=>ackPostgres(pool,event.id,event.leaseOwner,event.leaseUntil),
  fail:(event,reason,next)=>failPostgres(
    pool,event.id,event.leaseOwner,event.leaseUntil,reason,next,
  ),
});
const portSqlite=db=>({
  claim:async options=>claimSqlite(db,options),
  ack:async event=>ackSqlite(db,event.id,event.leaseOwner,event.leaseUntil),
  fail:async(event,reason,next)=>failSqlite(
    db,event.id,event.leaseOwner,event.leaseUntil,reason,next,
  ),
});
const deliver=(source,destination,workerId,batchSize=1)=>runDeliveryBatch(
  source,destination,{workerId,batchSize,leaseMs:120000},
);

test("actual X/TG mint verifiers and source emitters plus Blockchain revision emitter reach the Intelligence consumer",{
  skip:!url,
},async()=>{
  const suffix=randomBytes(6).toString("hex");
  const schemas={
    x:"producer_x_"+suffix,
    tg:"producer_tg_"+suffix,
    dst:"producer_dst_"+suffix,
  };
  const admin=new pg.Client({connectionString:url});
  let xPool,tgPool,dst,sqlite,adminConnected=false;
  const envKeys=[
    "X_INTELLIGENCE_OUTBOX_ENABLED","X_INTELLIGENCE_TOKEN_LINKS_ENABLED",
    "X_INTELLIGENCE_MINT_VERIFY_ENABLED","ALCHEMY_SOLANA_RPC_URL",
    "TG_INTELLIGENCE_OUTBOX_ENABLED","TG_INTELLIGENCE_TOKEN_LINKS_ENABLED",
    "BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED","BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED",
  ];
  const oldEnv=new Map(envKeys.map(key=>[key,process.env[key]]));
  try{
    await admin.connect();
    adminConnected=true;
    for(const schema of Object.values(schemas))
      await admin.query('CREATE SCHEMA "'+schema+'"');

    const makePool=schema=>new pg.Pool({
      connectionString:url,options:"-c search_path="+schema,max:3,
    });
    xPool=makePool(schemas.x);
    tgPool=makePool(schemas.tg);
    dst=makePool(schemas.dst);

    await xPool.query(POSTGRES_OUTBOX_DDL);
    await tgPool.query(POSTGRES_OUTBOX_DDL);
    for(const name of [
      "001_entity_registry.sql","002_timeline.sql",
      "004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql",
    ]){
      await dst.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }

    await xPool.query(
      "CREATE TABLE twitter_tweets("+
      "tweet_id BIGINT PRIMARY KEY,author_id BIGINT NOT NULL,text TEXT NOT NULL,posted_at BIGINT)",
    );
    await tgPool.query(
      "CREATE TABLE tg_sources(id BIGINT PRIMARY KEY,peer_id TEXT NOT NULL)",
    );
    await tgPool.query(
      "CREATE TABLE tg_messages(source_id BIGINT NOT NULL,message_id BIGINT NOT NULL,"+
      "text TEXT NOT NULL,posted_at TIMESTAMPTZ,edited_at TIMESTAMPTZ,PRIMARY KEY(source_id,message_id))",
    );
    await tgPool.query("INSERT INTO tg_sources(id,peer_id) VALUES(1,'123456789')");

    process.env.X_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    process.env.X_INTELLIGENCE_MINT_VERIFY_ENABLED="true";
    process.env.ALCHEMY_SOLANA_RPC_URL="https://solana.example/rpc";
    process.env.TG_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.TG_INTELLIGENCE_TOKEN_LINKS_ENABLED="true";
    process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED="true";
    process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED="true";

    // X: run the actual bounded candidate verifier with a mocked HTTPS RPC
    // response, then use the actual transactional X outbox emitter.
    const xText="PRIVATE X fixture text; literal mint "+mint;
    const xPostedAt=Date.parse("2026-10-30T10:00:00.000Z");
    await xPool.query(
      "INSERT INTO twitter_tweets(tweet_id,author_id,text,posted_at) VALUES($1,$2,$3,$4)",
      ["101","999",xText,xPostedAt],
    );
    const xResult=await verifyXTokenLinksOnce(
      parseMintVerificationArgs(["--execute","--limit=10","--max-rpc=2"]),
      {
        read:async(cursor,limit)=>{
          const result=await xPool.query(
            "SELECT tweet_id::text AS tweet_id,author_id::text AS author_id,text,"+
            "posted_at::text AS posted_at FROM twitter_tweets "+
            "WHERE tweet_id>$1::bigint ORDER BY tweet_id ASC LIMIT $2",
            [cursor,limit],
          );
          return result.rows;
        },
        verify:async(candidate)=>verifySolanaMintViaAlchemy(
          "https://solana.example/rpc",candidate,
          rpcStub(X_TOKEN_PROGRAM,"spl-token"),
        ),
        emit:async(tweet,candidate,proof)=>{
          const tx=await xPool.connect();
          try{
            await tx.query("BEGIN");
            const selected=await tx.query(
              "SELECT tweet_id::text AS tweet_id,author_id::text AS author_id,text,"+
              "posted_at::text AS posted_at FROM twitter_tweets "+
              "WHERE tweet_id=$1::bigint FOR UPDATE",
              [tweet.tweet_id],
            );
            const current=selected.rows[0];
            if(!current||current.text!==tweet.text||!current.author_id||
               current.author_id!==tweet.author_id||
               String(current.posted_at??"")!==String(tweet.posted_at??"")){
              await tx.query("ROLLBACK");
              return false;
            }
            const emitted=await emitXVerifiedTokenLinkOutbox(tx,{
              tweetId:current.tweet_id,authorId:current.author_id,text:current.text,
              mint:candidate,observedAt:new Date(),
              postedAt:current.posted_at===null?null:new Date(Number(current.posted_at)),
              mintVerification:proof,
            });
            await tx.query("COMMIT");
            return emitted;
          }catch(error){
            await tx.query("ROLLBACK").catch(()=>{});
            throw error;
          }finally{tx.release();}
        },
      },
    );
    assert.equal(xResult.requests,1);
    assert.equal(xResult.verified,1);
    assert.equal(xResult.emitted,1);
    assert.equal(xResult.deferred,0);

    // Telegram: verify the parsed Mint account with a mocked RPC response,
    // then persist the real source event in the same PostgreSQL transaction.
    const tgText="PRIVATE TG fixture text; literal mint "+mint;
    const tgPostedAt=new Date("2026-10-30T11:00:00.000Z");
    await tgPool.query(
      "INSERT INTO tg_messages(source_id,message_id,text,posted_at) VALUES(1,201,$1,$2)",
      [tgText,tgPostedAt],
    );
    const tgMint=await readMintAccount(
      "https://solana.example/rpc",mint,rpcStub(TG_TOKEN_PROGRAM,"spl-token"),
    );
    assert.deepEqual(tgMint,{decimals:6,owner:TG_TOKEN_PROGRAM});
    const tgObservedAt=new Date();
    const tgRevision=createHash("sha256").update(JSON.stringify([
      tgText,tgPostedAt.toISOString(),null,
    ])).digest("hex");
    const tgTx=await tgPool.connect();
    try{
      await tgTx.query("BEGIN");
      const current=await tgTx.query(
        "SELECT text,posted_at FROM tg_messages WHERE source_id=1 AND message_id=201 FOR UPDATE",
      );
      assert.equal(current.rows[0]?.text,tgText);
      assert.equal(await emitVerifiedTgTokenLinkOutbox(tgTx,{
        peerId:"123456789",messageId:"201",text:current.rows[0].text,
        mint,tokenProgram:tgMint.owner,provider:"alchemy-solana-rpc",
        sourceRevisionSha256:tgRevision,observedAt:tgObservedAt,
        postedAt:current.rows[0].posted_at,
      }),true);
      await tgTx.query("COMMIT");
    }catch(error){
      await tgTx.query("ROLLBACK").catch(()=>{});
      throw error;
    }finally{tgTx.release();}

    // Blockchain: use the actual revision event writer against an in-memory
    // SQLite source store. This is parsed wallet-swap evidence, NOT SPL Mint
    // proof, finalized transaction status or realized PnL.
    sqlite=new Database(":memory:");
    sqlite.exec(SQLITE_OUTBOX_DDL);
    sqlite.exec(
      "CREATE TABLE chain_seed_events("+
      "kind TEXT,address TEXT,signature TEXT,raw_revision INTEGER,payload_hash TEXT,"+
      "PRIMARY KEY(kind,address,signature))",
    );
    const observedAt=Date.now();
    const chainTransaction={
      signature,slot:320000001,timestamp:Math.floor((observedAt-120000)/1000),
      type:"SWAP",feePayer:wallet,fee:5000,
      events:{swap:{
        nativeInput:{account:wallet,amount:"1000000000"},
        tokenOutputs:[{
          userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"1000000",decimals:6},
        }],
      }},
      accountData:[{
        account:wallet,nativeBalanceChange:-1000005000,
        tokenBalanceChanges:[{
          userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"1000000",decimals:6},
        }],
      }],
    };
    const chainHash=createHash("sha256").update(JSON.stringify(chainTransaction)).digest("hex");
    const chainInput={
      kind:"wallet",address:wallet,signature,payloadHash:chainHash,
      rawRevision:1,observedAt,transaction:chainTransaction,
    };
    const chainWritten=sqlite.transaction(()=>{
      sqlite.prepare(
        "INSERT INTO chain_seed_events(kind,address,signature,raw_revision,payload_hash) "+
        "VALUES('wallet',?,?,1,?)",
      ).run(wallet,signature,chainHash);
      return emitTokenSwapRevisionOutbox(sqlite,chainInput);
    })();
    assert.equal(chainWritten,true);
    const chainPayload=JSON.parse(sqlite.prepare(
      "SELECT payload FROM outbox_events WHERE event_kind='token_swap_evidence_revision'",
    ).get().payload);
    assert.equal(chainPayload.swapRevision.status,"supported");
    assert.equal(chainPayload.swapRevision.canonicalTokenId,token);
    assert.equal(JSON.stringify(chainPayload).includes("nativeBalanceChange"),false);

    // All three physically separate source stores deliver into one isolated
    // Intelligence PostgreSQL target. No generic token timeline row is
    // fabricated from historical token-link or raw swap evidence.
    const sources=[
      portPg(xPool),portPg(tgPool),portSqlite(sqlite),
    ];
    for(const [index,source] of sources.entries()){
      assert.deepEqual(await deliver(source,dst,"producer-e2e-"+index),{
        claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0,
      });
    }
    const occurredBefore=new Date(Date.now()+86400000).toISOString();
    const knownBeforeEdit=new Date(Date.now()+60000).toISOString();
    const activeBefore=await queryActiveTokenLinks(dst,token,occurredBefore,knownBeforeEdit);
    assert.deepEqual(new Set(activeBefore.map(row=>row.source_system)),new Set(["x","tg"]));
    assert.equal((await queryActiveBlockchainSwapEvidence(
      dst,token,occurredBefore,knownBeforeEdit,
    )).length,1);
    assert.equal((await queryTokenTimeline(
      dst,token,occurredBefore,knownBeforeEdit,
    )).length,0);
    assert.ok(!JSON.stringify((await xPool.query("SELECT payload FROM outbox_events")).rows).includes(xText));
    assert.ok(!JSON.stringify((await tgPool.query("SELECT payload FROM outbox_events")).rows).includes(tgText));

    // Real source tombstone emitters retract the social evidence independently.
    const xTombstoneTx=await xPool.connect();
    try{
      await xTombstoneTx.query("BEGIN");
      const xEditedText="Edited PRIVATE X fixture text; literal mint "+mint;
      await xTombstoneTx.query(
        "UPDATE twitter_tweets SET text=$2 WHERE tweet_id=$1",
        ["101",xEditedText],
      );
      await emitXTokenLinksInvalidation(xTombstoneTx,{
        tweetId:"101",authorId:"999",reason:"edited",
        sourceRevisionSha256:createHash("sha256").update(JSON.stringify([
          xEditedText,new Date(xPostedAt).toISOString(),
        ])).digest("hex"),
        observedAt:new Date(Date.now()+2000),postedAt:new Date(xPostedAt),
      });
      await xTombstoneTx.query("COMMIT");
    }catch(error){
      await xTombstoneTx.query("ROLLBACK").catch(()=>{});
      throw error;
    }finally{xTombstoneTx.release();}

    const tgTombstoneTx=await tgPool.connect();
    try{
      await tgTombstoneTx.query("BEGIN");
      const tgEditedText="Edited PRIVATE TG fixture text; literal mint "+mint;
      const tgEditedAt=new Date(Date.now()+2000);
      await tgTombstoneTx.query(
        "UPDATE tg_messages SET text=$3,edited_at=$4 WHERE source_id=$1 AND message_id=$2",
        ["1",201,tgEditedText,tgEditedAt],
      );
      await emitTgTokenLinksInvalidation(tgTombstoneTx,"1",{
        messageId:201,reason:"edited",
        sourceRevisionSha256:createHash("sha256").update(JSON.stringify([
          tgEditedText,tgPostedAt.toISOString(),tgEditedAt.toISOString(),
        ])).digest("hex"),
        observedAt:new Date(Date.now()+3000),postedAt:tgPostedAt,
      });
      await tgTombstoneTx.query("COMMIT");
    }catch(error){
      await tgTombstoneTx.query("ROLLBACK").catch(()=>{});
      throw error;
    }finally{tgTombstoneTx.release();}

    assert.equal((await deliver(sources[0],dst,"x-edit")).delivered,1);
    assert.equal((await deliver(sources[1],dst,"tg-edit")).delivered,1);
    const knownAfterEdit=new Date(Date.now()+60000).toISOString();
    assert.equal((await queryActiveTokenLinks(
      dst,token,occurredBefore,knownAfterEdit,
    )).length,0);
    assert.equal((await queryActiveBlockchainSwapEvidence(
      dst,token,occurredBefore,knownAfterEdit,
    )).length,1,"social edits do not retract independent Blockchain evidence");
    assert.equal(Number((await dst.query(
      "SELECT COUNT(*)::integer AS n FROM token_link_observations",
    )).rows[0].n),4);

    // Simulate ACK loss after destination COMMIT: replay is at-least-once,
    // but the consumer remains idempotent for all five producer events.
    await xPool.query(
      "UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL",
    );
    await tgPool.query(
      "UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL",
    );
    sqlite.prepare(
      "UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL",
    ).run();
    const replayX=await deliver(sources[0],dst,"x-replay",10);
    const replayTg=await deliver(sources[1],dst,"tg-replay",10);
    const replayChain=await deliver(sources[2],dst,"chain-replay",10);
    assert.deepEqual(replayX,{claimed:2,delivered:0,duplicates:2,failed:0,lostLeases:0});
    assert.deepEqual(replayTg,{claimed:2,delivered:0,duplicates:2,failed:0,lostLeases:0});
    assert.deepEqual(replayChain,{claimed:1,delivered:0,duplicates:1,failed:0,lostLeases:0});
    assert.equal(Number((await dst.query(
      "SELECT COUNT(*)::integer AS n FROM intelligence_inbox",
    )).rows[0].n),5);
    assert.equal((await queryActiveTokenLinks(
      dst,token,occurredBefore,knownAfterEdit,
    )).length,0);
  }finally{
    for(const [key,value] of oldEnv){
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
    if(sqlite)sqlite.close();
    for(const pool of [xPool,tgPool,dst])if(pool)await pool.end();
    if(adminConnected){
      for(const schema of Object.values(schemas).reverse()){
        try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{/* preserve first failure */}
      }
      await admin.end();
    }
  }
});
