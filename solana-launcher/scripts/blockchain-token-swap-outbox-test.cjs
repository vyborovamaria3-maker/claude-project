"use strict";
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const {initDb,persistEvents}=require("./blockchain-seed-collector.cjs");
const {
  enabled,buildTokenSwapEvidenceEvent,
}=require("./blockchain-token-swap-outbox.cjs");
const {buildTokenSwapRevisionEvent}=require("./blockchain-token-swap-revisions.cjs");

const wallet="1".repeat(32);
const mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const signature="1".repeat(64);
const now=Date.UTC(2026,9,20,4,45,0);
const tx={
  signature,slot:250000000,timestamp:1700000000,type:"SWAP",
  feePayer:wallet,fee:5000,
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
const source={kind:"wallet",address:wallet,signature,
  payloadHash:"a".repeat(64),observedAt:now,transaction:tx};

assert.equal(enabled({}),false);
assert.equal(enabled({BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED:"true"}),false);
assert.equal(enabled({BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED:"true"}),false);
assert.equal(enabled({
  BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED:"true",
  BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED:"true",
}),true);

const event=buildTokenSwapEvidenceEvent(source);
assert(event);
assert.equal(event.eventKind,"token_swap_evidence_observed");
assert.equal(event.payload.timelineEvent.kind,"chain_transaction",
  "do not misrepresent a parsed swap as finalized trade_executed");
assert.deepEqual(event.payload.registryEvent.entityRefs.map(e=>e.kind),
  ["wallet","token"]);
assert.equal(event.payload.registryEvent.entityRefs[1].canonicalId,
  "solana:"+mint);
assert.equal(event.payload.registryEvent.evidenceRef.sourceId,
  "chain:tx:solana:"+signature);
assert.equal(event.payload.timelineEvent.occurredAt,
  new Date(tx.timestamp*1000).toISOString());
assert.equal(event.payload.timelineEvent.observedAt,
  new Date(now).toISOString());
assert.ok(!JSON.stringify(event).includes("tokenBalanceChanges"));
assert.ok(!JSON.stringify(event).includes("amountTokens"));

for(const transaction of [
  {...tx,type:"TRANSFER"},
  {...tx,error:{code:1}},
  {...tx,slot:null},
  {...tx,timestamp:undefined},
  {...tx,timestamp:2000000000},
  {...tx,accountData:[]},
  {...tx,accountData:[{...tx.accountData[0],nativeBalanceChange:-1000005001}]},
  {...tx,events:{swap:{...tx.events.swap,tokenOutputs:[
    ...tx.events.swap.tokenOutputs,
    {userAccount:wallet,mint:"4".repeat(32),rawTokenAmount:{tokenAmount:"2",decimals:0}},
  ]}}},
]){
  assert.equal(buildTokenSwapEvidenceEvent({...source,transaction}),null,
    "failed, incomplete, mixed or unreconciled tx cannot claim a mint");
}
assert.equal(buildTokenSwapEvidenceEvent({...source,kind:"token"}),null);
assert.throws(()=>buildTokenSwapEvidenceEvent({...source,address:"not-a-wallet"}));
assert.throws(()=>buildTokenSwapEvidenceEvent({...source,signature:"not-a-signature"}));
assert.throws(()=>buildTokenSwapEvidenceEvent({...source,payloadHash:"bad"}));
const revision=buildTokenSwapRevisionEvent({...source,rawRevision:1});
assert.equal(revision.eventKind,"token_swap_evidence_revision");
assert.equal(revision.payload.swapRevision.rawRevision,1);
assert.equal(revision.payload.swapRevision.status,"supported");
assert.equal(revision.payload.swapRevision.canonicalTokenId,"solana:"+mint);
assert.equal(revision.payload.swapRevision.slot,tx.slot);
assert.deepEqual(revision.payload.registryEvent.entityRefs.map(x=>x.kind),["wallet"]);
assert.equal(revision.payload.timelineEvent,undefined);
const noProof=buildTokenSwapRevisionEvent({...source,rawRevision:2,
  transaction:{...tx,type:"UNKNOWN"}});
assert.equal(noProof.payload.swapRevision.status,"unsupported");
assert.equal(noProof.payload.swapRevision.canonicalTokenId,null);
assert.equal(noProof.payload.swapRevision.slot,null);
assert.equal(noProof.payload.registryEvent.evidenceRef.occurredAt,undefined);
assert.equal(noProof.payload.timelineEvent,undefined);
for(const wrong of [
  {...source,rawRevision:0},{...source,rawRevision:1.5},
  {...source,rawRevision:Number.MAX_SAFE_INTEGER+1},
  {...source,rawRevision:1,address:"not-a-wallet"},
  {...source,rawRevision:1,payloadHash:"not-sha"},
])assert.throws(()=>buildTokenSwapRevisionEvent(wrong));


const oldBase=process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED;
const oldNew=process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED;
const db=new Database(":memory:");
try{
  // Real collector bootstraps outbox schema when base opt-in is enabled.
  process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED="true";
  process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED="true";
  initDb(db);
  assert.throws(()=>db.transaction(()=>{
    persistEvents(db,"wallet",wallet,[tx]);
    throw new Error("forced-rollback");
  })(),/forced-rollback/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,0);
  assert.equal(persistEvents(db,"wallet",wallet,[tx]),1);
  const rows=db.prepare("SELECT event_kind,payload FROM outbox_events ORDER BY id").all();
  assert.deepEqual(rows.map(r=>r.event_kind),[
    "wallet_transaction_observed","token_swap_evidence_observed",
    "token_swap_evidence_revision",
  ]);
  assert.equal(rows[1].payload.includes("nativeBalanceChange"),false);
  assert.equal(rows[2].payload.includes("nativeBalanceChange"),false);
  assert.equal(persistEvents(db,"wallet",wallet,[tx]),0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,3);
  const corrected={...tx,slot:250000001};
  assert.equal(persistEvents(db,"wallet",wallet,[corrected]),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,6,
    "new immutable raw revision must get token and revision events");
  const invalid={...corrected,slot:250000002,type:"UNKNOWN"};
  assert.equal(persistEvents(db,"wallet",wallet,[invalid]),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,8,
    "unknown revision emits wallet and superseding unsupported status, not a mint claim");
  const revisions=db.prepare(
    "SELECT payload FROM outbox_events WHERE event_kind='token_swap_evidence_revision' ORDER BY id"
  ).all().map(r=>JSON.parse(r.payload).swapRevision);
  assert.deepEqual(revisions.map(r=>[r.rawRevision,r.status,r.canonicalTokenId]),[
    [1,"supported","solana:"+mint],[2,"supported","solana:"+mint],
    [3,"unsupported",null],
  ]);
  assert.equal(db.prepare(
    "SELECT raw_revision FROM chain_seed_events WHERE kind='wallet' AND address=? AND signature=?"
  ).get(wallet,signature).raw_revision,3);
  delete process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED;
  assert.equal(persistEvents(db,"wallet",wallet,[{...tx,slot:250000003}]),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,9,
    "feature OFF returns to raw-only output");
}finally{
  if(oldBase===undefined)delete process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED;
  else process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED=oldBase;
  if(oldNew===undefined)delete process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED;
  else process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED=oldNew;
  db.close();
}
console.log("[blockchain-token-swap-outbox-test] OK: exact mint refs, conservative proof, revisions, rollback and dual opt-ins");
