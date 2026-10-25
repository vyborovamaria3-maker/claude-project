"use strict";
const {decodePumpSwap,classifyIntermediatePumpSell}=require("./blockchain-pump-swap-decoder.cjs");

function reconcileTradeEvidence({ events, trades, mint, knownTradeSignatures }) {
  const bySignature = new Map();
  for (const event of events || []) {
    if (!event?.signature) continue;
    const rows = bySignature.get(event.signature) || [];
    rows.push(event);
    bySignature.set(event.signature, rows);
  }
  const tradeSignatures = new Set();
  const duplicateTradeSignatures = [];
  const tradesWithoutEvent = [];
  const tradesWithFailedOrUnknownEvent = [];
  const slotMismatches = [];
  const ownerMismatches = [];
  const directionMismatches = [];
  const matched = [];
  const custodialAttributions = [];
  const intermediatePoolLegs = [];
  for (const trade of trades || []) {
    const signature = String(trade.signature || "");
    if (!signature) {
      tradesWithoutEvent.push({ signature: null, reason: "missing_signature" });
      continue;
    }
    if (tradeSignatures.has(signature)) duplicateTradeSignatures.push(signature);
    tradeSignatures.add(signature);
    const matches = bySignature.get(signature) || [];
    if (!matches.length) {
      tradesWithoutEvent.push({ signature, reason: "signature_not_in_raw_events" });
      continue;
    }
    const event = matches[0];
    if (event.transactionError !== null || event.transactionError === undefined) {
      tradesWithFailedOrUnknownEvent.push({
        signature,
        reason: event.transactionError == null ? "execution_metadata_unknown" : "transaction_failed",
      });
    }
    if (trade.slot != null && event.slot != null && Number(trade.slot) !== Number(event.slot)) {
      slotMismatches.push({ signature, tradeSlot: trade.slot, eventSlot: event.slot });
    }
    const deltas = (event.tokenBalanceDeltas || []).filter((d) => d.mint === mint && d.owner);
    // Rebuild the custody/beneficiary proof from the raw transaction. A caller's
    // attribution flag alone must never bypass owner/direction checks.
    const direct=deltas.find(d=>d.owner===trade.trader);
    const derived=String(trade.type).toLowerCase()==='sell'&&(!direct||direct.deltaRaw==='0')?decodePumpSwap(event,mint):null;
    const custody=derived?.attribution==='limit_order_beneficiary_and_custody_transfer'
      &&derived.trader===trade.trader&&derived.amountTokens===trade.amountTokens
      &&derived.quoteMint===trade.quoteMint&&derived.quoteAmount===trade.quoteAmount
      &&derived.quoteDecimals===trade.quoteDecimals&&derived.amountSol===trade.amountSol&&derived.priceSol===trade.priceSol
      &&(!trade.custodyOwner||trade.custodyOwner===derived.custodyOwner)?derived:null;
    if(custody)custodialAttributions.push({signature,trader:trade.trader,custodyOwner:custody.custodyOwner,executedBy:custody.executedBy});
    if (!custody && trade.trader && deltas.length && !deltas.some((d) => d.owner === trade.trader)) {
      ownerMismatches.push({ signature, trader: trade.trader, observedOwners: [...new Set(deltas.map((d) => d.owner))] });
    }
    const deltaForTrader = deltas.find((d) => custody ? d.owner===custody.custodyOwner : !trade.trader || d.owner === trade.trader);
    if (deltaForTrader && ["buy", "sell"].includes(String(trade.type).toLowerCase())) {
      const expectedSign = String(trade.type).toLowerCase() === "buy" ? 1 : -1;
      const actualSign = Math.sign(Number(deltaForTrader.deltaRaw));
      if (actualSign !== expectedSign) {
        directionMismatches.push({ signature, type: trade.type, deltaRaw: deltaForTrader.deltaRaw });
      }
    }
    matched.push(signature);
  }
  const allTradeSignatures = new Set(knownTradeSignatures || tradeSignatures);
  const eventsWithMintDeltaNoTrade = [];
  for (const [signature, rows] of bySignature.entries()) {
    if (allTradeSignatures.has(signature)) continue;
    const event = rows[0];
    if (event.transactionError !== null || event.transactionError === undefined) continue;
    const intermediate=classifyIntermediatePumpSell(event,mint);
    if(intermediate){intermediatePoolLegs.push(intermediate);continue;}
    if ((event.tokenBalanceDeltas || []).some((d) => d.mint === mint && d.owner && String(d.deltaRaw) !== "0")) {
      eventsWithMintDeltaNoTrade.push(signature);
    }
  }
  const anomalyCount = tradesWithoutEvent.length + tradesWithFailedOrUnknownEvent.length
    + slotMismatches.length + ownerMismatches.length + directionMismatches.length
    + duplicateTradeSignatures.length;
  return {
    status: anomalyCount ? "needs_review" : "observed_matches_no_detected_mismatch",
    authority: "diagnostic_only",
    historyComplete: false,
    mint,
    rawEventCount: (events || []).length,
    normalizedTradeCount: (trades || []).length,
    matchedTradeCount: matched.length,
    uniqueTradeSignatureCount: tradeSignatures.size,
    tradesWithoutEvent,
    duplicateTradeSignatures,
    tradesWithFailedOrUnknownEvent,
    slotMismatches,
    ownerMismatches,
    directionMismatches,
    eventsWithMintDeltaNoTrade,
    custodialAttributions,
    intermediatePoolLegs,
    note: "A clean signature-level match does not prove full transaction coverage, full inventory provenance, or complete swap decoding.",
  };
}

module.exports = { reconcileTradeEvidence };
