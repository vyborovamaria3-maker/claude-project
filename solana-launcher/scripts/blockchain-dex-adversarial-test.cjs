"use strict";
// Negative-only adversarial DEX regression against saved, REAL Alchemy swaps.
// Synthetic mutations must never create an authoritative trade.
const assert = require("node:assert/strict");
const {normalizeFullTransaction,createAlchemyProvider} = require("./blockchain-alchemy-provider.cjs");
const fixtures = require("./fixtures/alchemy-saved-swaps.json");
const MINT = "DWvZqqQKR2GejFVoc2Vcywg2GKLkdTqpCzWhZ2sKpump";
const DISCRIMINATOR = "bddb7fd34ee661ee";
const p = createAlchemyProvider({endpoint:"https://solana-mainnet.g.alchemy.com/v2/offline",
  fetch:()=>{throw new Error("Offline DEX tests may not use RPC");}});
const saved = fixtures.map(normalizeFullTransaction);
const known = p.txsToTrades(saved,MINT);
assert.equal(known.length,10,"The existing saved RAW fixture must remain usable");
const reference = saved.find(tx=>tx.signature.startsWith("127nj1UJN"));
assert.ok(reference);
const signer = known.find(t=>t.signature === reference.signature).trader;
const targetDelta = tx => tx.tokenBalanceDeltas.find(d => d.owner === signer && d.mint === MINT);
function changeEvent(tx, edit) {
  let edited = false;
  tx.raw.meta.logMessages = tx.raw.meta.logMessages.map(line => {
    if (!line.startsWith("Program data: ")) return line;
    const data = Buffer.from(line.slice("Program data: ".length),"base64");
    if (data.subarray(0,8).toString("hex") !== DISCRIMINATOR) return line;
    edit(data);edited = true;
    return "Program data: " + data.toString("base64");
  });
  assert.ok(edited,"Fixture must contain the canonical Pump TradeEvent");
}
const scenarios = [
  {name:"token-2022 style withheld/split fill with third owner delta", mutate(tx) {
    tx.tokenBalanceDeltas.push({...targetDelta(tx), owner:"external-fee-vault",deltaRaw:"1"});
  }},
  {name:"unverified multi-hop quote token change",mutate(tx) {
    tx.tokenBalanceDeltas.push({owner:signer,mint:"UnprovenOtherMint",
      deltaRaw:"-1000000",decimals:6,tokenAccount:"third-party-route"});
  }},
  {name:"multi-fill protocol events without leg attribution",mutate(tx) {
    tx.raw.meta.logMessages = tx.raw.meta.logMessages.flatMap(line =>
      line.startsWith("Program data: ") ? [line,line] : [line]);
  }},
  {name:"atomic token amount exceeding safe legacy trade projection",mutate(tx) {
    changeEvent(tx, data => data.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER)+1n,48));
  }},
  {name:"unknown instruction execution evidence",mutate(tx) {
    tx.transactionError = undefined;
  }},
  {name:"crossed signing identity",mutate(tx) {
    tx.raw.transaction.message.accountKeys.forEach(k=>{if(k.pubkey===signer)k.signer=false;});
  }},
  {name:"missing checked SPL transfer",mutate(tx) {
    for (const group of tx.raw.meta.innerInstructions) {
      group.instructions = group.instructions.filter(ix=>ix.parsed?.type!=="transferChecked");
    }
  }},
  {name:"spoofed event emitted outside canonical Pump stack",mutate(tx) {
    tx.raw.meta.logMessages=tx.raw.meta.logMessages.map(x=>
      x.startsWith("Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P ") ?
        x.replace("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P","FakeProgram") : x);
  }}
];
for (const s of scenarios) {
  const tx=structuredClone(reference);
  s.mutate(tx);
  assert.equal(p.txsToTrades([tx],MINT).length,0,
    "Unsafe DEX scenario must remain undecoded: "+s.name);
}
console.log("[blockchain-dex-adversarial] OK: "+scenarios.length+
  " replay-only rejection scenarios; Raydium/Orca/Jupiter verification is NOT claimed");
