"use strict";
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const {initDb,persistEvents}=require("./blockchain-seed-collector.cjs");
const {
  enabled,buildTokenSwapEvidenceEvent,
}=require("./blockchain-token-swap-outbox.cjs");

const wallet="1".repeat(32);
const mint="2".repeat(32);
const signature="3".repeat(64);
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

const oldBase=process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED;
const oldNew=process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED;
const db=new Database(":memory:");
try{
  initDb(db);
  process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED="true";
  process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED="true";
  assert.throws(()=>db.transaction(()=>{
    persistEvents(db,"wallet",wallet,[tx]);
    throw new Error("forced-rollback");
  })(),/forced-rollback/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chain_seed_events").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,0);
  assert.equal(persistEvents(db,"wallet",wallet,[tx]),1);
  const rows=db.prepare("SELECT event_kind,payload FROM outbox_events ORDER BY id").all();
  assert.deepEqual(rows.map(r=>r.event_kind),
    ["wallet_transaction_observed","token_swap_evidence_observed"]);
  assert.equal(rows[1].payload.includes("nativeBalanceChange"),false);
  assert.equal(persistEvents(db,"wallet",wallet,[tx]),0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,2);
  const corrected={...tx,slot:250000001};
  assert.equal(persistEvents(db,"wallet",wallet,[corrected]),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,4,
    "new immutable raw revision must get its own token observation");
  const invalid={...corrected,slot:250000002,type:"UNKNOWN"};
  assert.equal(persistEvents(db,"wallet",wallet,[invalid]),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,5,
    "unknown revised raw may still be retained but must not create a new token claim");
  delete process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED;
  assert.equal(persistEvents(db,"wallet",wallet,[{...tx,slot:250000003}]),1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,6,
    "feature OFF returns to raw-only output");
}finally{
  if(oldBase===undefined)delete process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED;
  else process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED=oldBase;
  if(oldNew===undefined)delete process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED;
  else process.env.BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED=oldNew;
  db.close();
}
console.log("[blockchain-token-swap-outbox-test] OK: exact mint refs, conservative proof, revisions, rollback and dual opt-ins");
