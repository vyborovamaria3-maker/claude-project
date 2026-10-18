"use strict";
/**
 * Source-only, opt-in SQLite outbox for wallet-target Solana raw evidence.
 * Never calls a provider, never opens another DB and never asserts a trade/PnL.
 * Source writes and outbox INSERT must share the same better-sqlite3 transaction.
 */
const {isSolanaAddress}=require("./blockchain-seed-core.cjs");
const BASE58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodedBytes(value) {
  if(typeof value!=="string"||value.length>128||value.length<1)return -1;
  let n=0n;
  for(const c of value){const d=BASE58.indexOf(c);if(d<0)return -1;n=n*58n+BigInt(d);}
  let length=0;
  while(n>0n){n>>=8n;length++;}
  for(const c of value){if(c!=="1")break;length++;}
  return length;
}
function enabled(env=process.env) {return env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED==="true";}
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS outbox_events (
    id INTEGER PRIMARY KEY,
    source_system TEXT NOT NULL CHECK(source_system='blockchain'),
    event_kind TEXT NOT NULL,
    event_key TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    processed_at TEXT,
    lease_owner TEXT,
    lease_until TEXT,
    next_attempt_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    dead_lettered_at TEXT,
    last_error TEXT,
    UNIQUE(source_system,event_kind,event_key)
  );
  CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(next_attempt_at,id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;`);
}
function buildWalletRawEvent(input) {
  if(input.kind!=="wallet")return null;
  if(!isSolanaAddress(input.address)||decodedBytes(input.address)!==32)
    throw new TypeError("Invalid 32-byte Solana wallet target");
  if(decodedBytes(input.signature)!==64)throw new TypeError("Invalid 64-byte Solana signature");
  if(typeof input.payloadHash!=="string"||!/^[0-9a-f]{64}$/.test(input.payloadHash))
    throw new TypeError("Invalid raw evidence hash");
  if(!Number.isSafeInteger(input.observedAt)||input.observedAt<0)
    throw new TypeError("Invalid evidence observedAt");
  const observedAt=new Date(input.observedAt).toISOString();
  // Provider time is second-level Unix time when valid. Never invent missing time.
  const plausible=Number.isSafeInteger(input.blockTime)&&input.blockTime>0&&
    input.blockTime<8640000000000;
  const occurredAt=plausible?new Date(input.blockTime*1000).toISOString():observedAt;
  const eventKey="chain:wallet:"+input.address+":signature:"+input.signature+":hash:"+input.payloadHash;
  const evidenceRef={sourceKind:"chain_tx",sourceId:"chain:tx:solana:"+input.signature,
    observedAt,occurredAt,parserVersion:"chain-seed-v1"};
  const entityRefs=[{kind:"wallet",canonicalId:"solana:"+input.address,
    firstSeenAt:observedAt,lastSeenAt:observedAt}];
  return {
    sourceSystem:"blockchain",eventKind:"wallet_transaction_observed",
    eventKey,schemaVersion:"chain-raw-v1",
    payload:{
      registryEvent:{sourceSystem:"blockchain",eventKind:"wallet_transaction_observed",
        eventKey,schemaVersion:"chain-raw-v1",entityRefs,evidenceRef},
      timelineEvent:{schemaVersion:"timeline-v1",eventKey,kind:"chain_transaction",
        occurredAt,observedAt,entityRefs,evidenceRef,payload:{}},
    }
  };
}
function emitRawChainOutbox(db,input){
  if(!enabled())return false;
  const event=buildWalletRawEvent(input);
  if(!event)return false;
  const now=new Date(input.observedAt).toISOString();
  db.prepare(`INSERT OR IGNORE INTO outbox_events
    (source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at)
    VALUES(?,?,?,?,?,?,?)`).run(event.sourceSystem,event.eventKind,event.eventKey,
      event.schemaVersion,JSON.stringify(event.payload),now,now);
  return true;
}
module.exports={enabled,ensureSchema,buildWalletRawEvent,emitRawChainOutbox};
