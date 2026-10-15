#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { parseEvidence, computePnl, computePnlOrdered, WSOL } = require("./blockchain-forensics-core.cjs");
const WALLET = "Wallet11111111111111111111111111111111111";
const OTHER = "Other111111111111111111111111111111111111";
const MINT = "Mint1111111111111111111111111111111111111";
const ALT = "Mint2222222222222222222222222222222222222";
const quote = (qty) => ({ tokenAmount: String(qty * 1000000), decimals: 6 });
function buy(signature, slot, qty, sol, opts = {}) {
  return { signature, timestamp: slot * 100, slot, feePayer: WALLET,
    fee: 5000, type: "SWAP", ...opts,
    accountData: [{account: WALLET, nativeBalanceChange: -(sol * 1e9) - 5000,
      tokenBalanceChanges:[{userAccount:WALLET,mint:MINT,rawTokenAmount:quote(qty)}]}],
    events: { swap: { nativeInput: { account: WALLET, amount: String(sol * 1e9) },
      tokenOutputs: [{ userAccount: WALLET, mint: MINT, rawTokenAmount: quote(qty) }] } } };
}
function sell(signature, slot, qty, sol, opts = {}) {
  return { signature, timestamp: slot * 100, slot, feePayer: WALLET,
    fee: 5000, type: "SWAP", ...opts,
    accountData: [{account: WALLET, nativeBalanceChange: sol * 1e9 - 5000,
      tokenBalanceChanges:[{userAccount:WALLET,mint:MINT,rawTokenAmount:quote(-qty)}]}],
    events: { swap: { nativeOutput: { account: WALLET, amount: String(sol * 1e9) },
      tokenInputs: [{ userAccount: WALLET, mint: MINT, rawTokenAmount: quote(qty) }] } } };
}
const events = [...parseEvidence(buy("tx-buy", 1, 10, 2), WALLET),
  ...parseEvidence(sell("tx-sell", 2, 5, 1.5), WALLET)];
assert.deepEqual(events.map(e => e.kind), ["buy", "sell"]);
const verified = computePnl(events, true)[0];
assert.equal(verified.status, "verified");
assert(Math.abs(verified.totalRealizedPnlSol - (1.5 - 0.000005 - (2 + 0.000005)/2)) < 1e-9);
const missing = computePnl(events, false)[0];
assert.equal(missing.totalRealizedPnlSol, null);
assert.equal(missing.status, "unknown");
assert.equal(missing.knownSellCount, 0);
assert.equal(missing.knownRealizedPnlSol, null);
assert(missing.reasons.includes("history_incomplete"));
const transfer = { signature: "tx-transfer", slot: 3, timestamp: 300,
  feePayer: OTHER, fee: 5000, type: "TRANSFER",
  tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET,
    mint: MINT, tokenAmount: 7 }] };
const received = parseEvidence(transfer, WALLET);
assert.equal(received.length, 1);
assert.equal(received[0].kind, "transfer_in");
assert.equal(received[0].counterparty, OTHER);
const unknownBasis = computePnl([...received, ...parseEvidence(sell("sell-received", 4, 7, 2), WALLET)], true)[0];
assert.equal(unknownBasis.totalRealizedPnlSol, null);
assert(unknownBasis.reasons.includes("sale_without_verified_cost_basis"));
const undecoded = parseEvidence({ ...transfer, type: "SWAP" }, WALLET);
assert.equal(undecoded[0].kind, "unpriced", "missing decoded swap cannot become a transfer");
assert.equal(parseEvidence({ ...buy("failed", 5, 1, 1), transactionError: {} }, WALLET).length, 0);
assert.equal(parseEvidence({ ...buy("not-owner", 5, 1, 1), feePayer: OTHER }, OTHER).length, 0);
const multi = buy("two-outs", 6, 1, 1);
multi.events.swap.tokenOutputs.push({ userAccount: WALLET, mint: ALT, rawTokenAmount: quote(1) });
assert(parseEvidence(multi, WALLET).every(e => e.kind === "unpriced"));
const wsol = buy("wsol-input", 7, 1, 1);
delete wsol.events.swap.nativeInput;
wsol.events.swap.tokenInputs = [{ userAccount: WALLET, mint: WSOL,
  rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }];
wsol.accountData[0].nativeBalanceChange = -5000;
wsol.accountData[0].tokenBalanceChanges.push({userAccount:WALLET,mint:WSOL,rawTokenAmount:{tokenAmount:"-1000000000",decimals:9}});
assert.equal(parseEvidence(wsol, WALLET)[0].kind, "buy");
const noFee = buy("no-fee", 8, 1, 1);
delete noFee.fee;
assert.equal(computePnl([...parseEvidence(noFee, WALLET),
  ...parseEvidence(sell("no-fee-sell", 9, 1, 2), WALLET)], true)[0].totalRealizedPnlSol, null);
assert.equal(computePnl([parseEvidence(buy("only-buy", 10, 1, 1), WALLET)[0]],true)[0].status,"unknown");
const nativeTx={signature:"sol-transfer",slot:14,timestamp:1400,type:"TRANSFER",nativeTransfers:[{fromUserAccount:WALLET,toUserAccount:OTHER,amount:100000000}]};
const nativeEvents=parseEvidence(nativeTx,WALLET);
assert.equal(nativeEvents[0].kind,"sol_transfer_out");
assert.equal(nativeEvents[0].amountSol,0.1);
assert.equal(computePnl(nativeEvents,true).length,0,"SOL transfers cannot become token realized PnL");
const phantomBalance = buy("phantom-balance", 15, 5, 1);
phantomBalance.accountData[0].tokenBalanceChanges[0].rawTokenAmount.tokenAmount = "4000000";
assert(parseEvidence(phantomBalance, WALLET).some(e => e.kind === "unpriced"));
const unknownTx = {signature:"unknown-wallet-delta",slot:16,timestamp:1600,type:"UNKNOWN",
 accountData:[{account:WALLET,nativeBalanceChange:0,
 tokenBalanceChanges:[{mint:ALT,userAccount:WALLET,rawTokenAmount:quote(5)}]}]};
assert.equal(parseEvidence(unknownTx,WALLET)[0].kind,"unpriced");
const extraFee = buy("native-fee", 17, 5, 1);
extraFee.events.swap.nativeFees = [{account:WALLET,amount:"1000"}];
assert.equal(computePnl([...parseEvidence(extraFee,WALLET),
 ...parseEvidence(sell("native-fee-sale",18,5,2),WALLET)],true)[0].status,"unknown");
const noOrdering = buy("missing-order", 11, 1, 1);
delete noOrdering.slot;
assert.equal(computePnl([...parseEvidence(noOrdering, WALLET),
  ...parseEvidence(sell("after-no-order", 12, 1, 2), WALLET)], true)[0].totalRealizedPnlSol, null);

function sorted(items) {
  return [...items].sort((a,b)=>a.mint.localeCompare(b.mint) ||
    (a.slot??a.timestamp??0)-(b.slot??b.timestamp??0) ||
    (a.timestamp??0)-(b.timestamp??0) ||
    a.signature.localeCompare(b.signature) || a.index-b.index);
}
// Equivalent FIFO results without retaining a wallet-wide list of activities.
const sampleGroups=[
  events,
  [...received,...parseEvidence(sell("sell-received",4,7,2),WALLET)],
  [...parseEvidence(buy("early",1,1,1),WALLET),...parseEvidence(sell("first-sale",2,1,2),WALLET),
    ...parseEvidence(noOrdering,WALLET)],
  [...parseEvidence(buy("same-slot-buy",1,1,1),WALLET),
    ...parseEvidence(sell("same-slot-sale",1,1,2),WALLET)],
  [...parseEvidence(buy("good",1,1,1),WALLET),
    ...parseEvidence(sell("good-sale",2,1,2),WALLET),
    ...parseEvidence(unknownTx,WALLET)],
];
for (const caseEvents of sampleGroups) for(const complete of [true,false]) {
  const oracle=computePnl(caseEvents,complete).sort((a,b)=>a.mint.localeCompare(b.mint));
  const streaming=computePnlOrdered(sorted(caseEvents),complete);
  assert.equal(streaming.length,oracle.length);
  for (let i=0;i<oracle.length;i++) {
    const a=oracle[i],b=streaming[i];
    for(const field of ["mint","buys","sells","transfers","knownSellCount","status",
      "totalRealizedPnlSol","knownRealizedPnlSol"])
      assert.equal(b[field],a[field],field+" must match batch FIFO oracle");
    assert.deepEqual([...b.reasons].sort(),[...a.reasons].sort());
  }
}
function* largeWalletEvidence(n) {
  for(let i=0;i<n;i++) {
    yield {mint:MINT,signature:"big-buy-"+i,slot:i*2+1,timestamp:i*2+1,
      index:0,kind:"buy",amountTokens:1,amountSol:1,feeSol:0};
    yield {mint:MINT,signature:"big-sell-"+i,slot:i*2+2,timestamp:i*2+2,
      index:0,kind:"sell",amountTokens:1,amountSol:2,feeSol:0};
  }
}
const many=computePnlOrdered(largeWalletEvidence(20000),true);
assert.equal(many.length,1);
assert.equal(many[0].sells,20000);
assert.equal(many[0].knownSellCount,20000);
assert.equal(many[0].totalRealizedPnlSol,20000);
// Token decimals can represent quantities below 1e-10. Absolute FIFO dust
// thresholds must never turn an unmatched sale into verified profit.
for (const calculate of [computePnl, computePnlOrdered]) {
  const sale={mint:MINT,signature:"tiny-sale",slot:2,timestamp:2,index:0,
    kind:"sell",amountTokens:1e-12,amountSol:2,feeSol:0};
  assert.equal(calculate([sale],true)[0].totalRealizedPnlSol,null);
  const purchase={...sale,signature:"tiny-buy",slot:1,timestamp:1,
    kind:"buy",amountTokens:2e-12,amountSol:2};
  assert.equal(calculate([purchase,sale],true)[0].totalRealizedPnlSol,1);
  assert.equal(calculate([{...purchase,amountTokens:0.5e-12},sale],true)[0].totalRealizedPnlSol,null);
}
const oneLamportMismatch=buy("one-lamport-mismatch",20,1,1);
oneLamportMismatch.accountData[0].nativeBalanceChange-=1;
assert(parseEvidence(oneLamportMismatch,WALLET).some(e=>e.kind==="unpriced"));
const tinyMismatch=buy("tiny-balance-mismatch",21,1,1);
tinyMismatch.events.swap.tokenOutputs[0].rawTokenAmount={tokenAmount:"1",decimals:12};
tinyMismatch.accountData[0].tokenBalanceChanges[0].rawTokenAmount={tokenAmount:"0",decimals:12};
assert(parseEvidence(tinyMismatch,WALLET).some(e=>e.kind==="unpriced"));
console.log("[blockchain-forensics-regression] OK: FIFO, tiny quantities, exact lamports, balance reconciliation, fees, unknown coverage and failed tx");
