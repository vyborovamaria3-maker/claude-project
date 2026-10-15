"use strict";

// Evidence rules: never infer swaps from the largest transfers in a transaction.
// Only verified Helius swap legs with an attributable SOL/WSOL quote become priced trades.
const WSOL = "So11111111111111111111111111111111111111112";
const EPS = 1e-10;
function num(v) { if (v === null || v === undefined || v === "") return null;
  const n = Number(v); return Number.isFinite(n) ? n : null; }
function rawQty(leg) {
  const r = leg && leg.rawTokenAmount;
  if (!r || !/^\d+$/.test(String(r.tokenAmount ?? ""))) return null;
  const d = Number(r.decimals);
  const n = Number(r.tokenAmount);
  if (!Number.isInteger(d) || d < 0 || d > 18 || !Number.isSafeInteger(n)) return null;
  return n / 10 ** d;
}
function lamports(v) {
  if (!/^\d+$/.test(String(v ?? ""))) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n / 1e9 : null;
}
function feeOf(tx, wallet) {
  if (tx.fee === undefined || tx.fee === null) return null;
  if (tx.feePayer !== wallet) return tx.feePayer ? 0 : null;
  return lamports(tx.fee);
}

function signedRawQty(leg) {
  const raw = leg && leg.rawTokenAmount;
  if (!raw || !/^-?\d+$/.test(String(raw.tokenAmount ?? ""))) return null;
  const decimals = Number(raw.decimals);
  const amount = Number(raw.tokenAmount);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
      !Number.isSafeInteger(amount)) return null;
  return amount / 10 ** decimals;
}

// Reconcile *all* wallet-owned token balance changes against recognized legs.
// Undecodable or missing evidence is unknown, never an implicit zero trade.
function reconcileEvidence(tx, wallet, out, add, swap = null) {
  const priced = out.filter(e => e.kind === "buy" || e.kind === "sell");
  if (!Array.isArray(tx.accountData)) {
    for (const e of priced) add("unpriced", e.mint, null, null, null);
    return;
  }
  const observed = new Map();
  const invalidMints = new Set();
  for (const item of tx.accountData) {
    for (const change of item.tokenBalanceChanges || []) {
      if (change.userAccount !== wallet) continue;
      const mint = change.mint;
      if (!mint) continue;
      const quantity = signedRawQty(change);
      if (quantity == null) invalidMints.add(mint);
      else observed.set(mint, (observed.get(mint) || 0) + quantity);
    }
  }
  const expected = new Map();
  for (const event of out) {
    if (event.kind === "unpriced" || event.mint === WSOL) continue;
    const direction = event.kind === "buy" || event.kind === "transfer_in" ? 1 : -1;
    expected.set(event.mint, (expected.get(event.mint) || 0) + direction * event.amountTokens);
  }
  const touched = new Set([...observed.keys(), ...expected.keys(), ...invalidMints]);
  for (const mint of touched) {
    if (mint === WSOL) continue;
    const actual = observed.get(mint), predicted = expected.get(mint);
    const eps = Math.max(1e-9, Math.abs(predicted ?? 0) * 1e-9);
    if (invalidMints.has(mint) || actual == null || predicted == null ||
        Math.abs(actual - predicted) > eps) {
      add("unpriced", mint, null, null, null);
    }
  }

  if (priced.length && swap) {
    const unsafeFees = (swap.nativeFees || []).length > 0 ||
      (swap.tokenFees || []).length > 0 || (swap.innerSwaps || []).length > 1;
    const accounts = tx.accountData.filter(a => a.account === wallet);
    const native = accounts.reduce((sum, a) =>
      sum + (num(a.nativeBalanceChange) ?? NaN), 0);
    const fee = priced[0].feeSol;
    let expectedNative = fee == null ? NaN : -fee;
    let expectedWsol = 0;
    for (const e of priced) {
      const direction = e.kind === "buy" ? -1 : 1;
      if (e.quoteKind === "wsol") expectedWsol += direction * e.amountSol;
      else expectedNative += direction * e.amountSol;
    }
    // Native balance amounts are lamports, swap amounts are SOL.
    if (unsafeFees || !accounts.length || !Number.isFinite(native) ||
        !Number.isFinite(expectedNative) ||
        Math.abs(native / 1e9 - expectedNative) > 1e-8 ||
        (expectedWsol !== 0 &&
          (observed.get(WSOL) == null ||
           Math.abs(observed.get(WSOL) - expectedWsol) > 1e-8))) {
      for (const e of priced) add("unpriced", e.mint, null, null, null);
    }
  }
}

function parseEvidence(tx, wallet) {
  if (!tx || !tx.signature || tx.transactionError != null || tx.error != null) return [];
  const slot = num(tx.slot), timestamp = num(tx.timestamp);
  const out = [];
  const add = (kind, mint, amountTokens, amountSol, feeSol, counterparty = null) => {
    if (!mint || (mint === WSOL && !kind.startsWith("sol_transfer"))) return;
    const quantity = Number.isFinite(amountTokens) && amountTokens > 0 ? amountTokens : null;
    if (quantity == null && kind !== "unpriced") return;
    out.push({ wallet, signature: tx.signature, slot, timestamp, index: out.length,
      kind, mint, amountTokens: quantity, amountSol, feeSol, counterparty });
  };
  const swap = tx.events && tx.events.swap;
  if (swap) {
    const inputs = swap.tokenInputs || [], outputs = swap.tokenOutputs || [];
    const ordinaryIn = inputs.filter(x => x.mint !== WSOL);
    const ordinaryOut = outputs.filter(x => x.mint !== WSOL);
    const solIn = swap.nativeInput ? lamports(swap.nativeInput.amount) :
      inputs.length === 1 && inputs[0].mint === WSOL ? rawQty(inputs[0]) : null;
    const solOut = swap.nativeOutput ? lamports(swap.nativeOutput.amount) :
      outputs.length === 1 && outputs[0].mint === WSOL ? rawQty(outputs[0]) : null;
    const payerIn = swap.nativeInput ? swap.nativeInput.account :
      inputs.find(x => x.mint === WSOL)?.userAccount;
    const payerOut = swap.nativeOutput ? swap.nativeOutput.account :
      outputs.find(x => x.mint === WSOL)?.userAccount;
    const fee = feeOf(tx, wallet);
    const quoteKind = swap.nativeInput || swap.nativeOutput ? "native" : "wsol";
    // A swap may carry both token and SOL legs. Never allocate a single quote
    // to multiple assets or to a different wallet.
    for (const leg of ordinaryOut) {
      if (leg.userAccount !== wallet) continue;
      const quantity = rawQty(leg);
      if (ordinaryOut.length === 1 && ordinaryIn.length === 0
          && solIn != null && solIn > 0 && payerIn === wallet) {
        add("buy", leg.mint, quantity, solIn, fee);
        if (out.length) out[out.length - 1].quoteKind = quoteKind;
      } else add("unpriced", leg.mint, quantity, null, null);
    }
    for (const leg of ordinaryIn) {
      if (leg.userAccount !== wallet) continue;
      const quantity = rawQty(leg);
      if (ordinaryIn.length === 1 && ordinaryOut.length === 0
          && solOut != null && solOut > 0 && payerOut === wallet) {
        add("sell", leg.mint, quantity, solOut, fee);
        if (out.length) out[out.length - 1].quoteKind = quoteKind;
      } else add("unpriced", leg.mint, quantity, null, null);
    }
    reconcileEvidence(tx, wallet, out, add, swap);
    return out;
  }
  // Only explicitly classified transfers are treated as transfers. An
  // undecoded swap must not be mislabeled as a gift or sale.
  const transfers = tx.tokenTransfers || [];
  const recognizedTransfer = tx.type === "TRANSFER";
  for (const leg of transfers) {
    if (leg.fromUserAccount !== wallet && leg.toUserAccount !== wallet) continue;
    const quantity = num(leg.tokenAmount);
    if (!(quantity > 0) || leg.mint === WSOL) continue;
    const kind = !recognizedTransfer ? "unpriced" :
      leg.toUserAccount === wallet ? "transfer_in" : "transfer_out";
    const other = leg.toUserAccount === wallet ? leg.fromUserAccount : leg.toUserAccount;
    add(kind, leg.mint, quantity, null, null, other || null);
  }
  if (recognizedTransfer) {
    for (const leg of tx.nativeTransfers || []) {
      if (leg.fromUserAccount !== wallet && leg.toUserAccount !== wallet) continue;
      const amountSol = lamports(leg.amount);
      if (!(amountSol > 0)) continue;
      const incoming = leg.toUserAccount === wallet;
      add(incoming ? "sol_transfer_in" : "sol_transfer_out", WSOL,
        amountSol, amountSol, null,
        incoming ? (leg.fromUserAccount || null) : (leg.toUserAccount || null));
    }
  }
  reconcileEvidence(tx, wallet, out, add);
  return out;
}

function computePnl(events, coverageComplete) {
  const grouped = new Map();
  for (const ev of events) {
    // SOL funding transfers are graph evidence, not a profitable token trade.
    if (ev.mint === WSOL) continue;
    if (!grouped.has(ev.mint)) grouped.set(ev.mint, []);
    grouped.get(ev.mint).push(ev);
  }
  const results = [];
  for (const [mint, rows] of grouped) {
    rows.sort((a,b) => (a.slot ?? a.timestamp ?? 0) - (b.slot ?? b.timestamp ?? 0)
      || (a.timestamp ?? 0) - (b.timestamp ?? 0)
      || a.signature.localeCompare(b.signature) || a.index - b.index);
    const lots = [], reasons = new Set();
    let knownPnl = 0, knownSellCount = 0, sells = 0, buys = 0, transfers = 0;
    // A matched pair is not proven FIFO if earlier history or intermediate
    // balance-changing activity could be missing or undecodable.
    let basisTainted = !coverageComplete;
    if (!coverageComplete) reasons.add("history_incomplete");
    if (rows.some(e => e.slot == null || e.timestamp == null)) {
      reasons.add("missing_order_metadata");
      basisTainted = true;
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].slot != null && rows[i].slot === rows[i - 1].slot
          && rows[i].signature !== rows[i - 1].signature)
        { reasons.add("same_slot_order_unverified"); basisTainted = true; }
    }
    function consume(qty) {
      const consumed = [];
      while (qty > EPS && lots.length) {
        const lot = lots[0], n = Math.min(qty, lot.qty);
        const cost = lot.cost == null ? null : lot.cost * n / lot.qty;
        consumed.push({ qty: n, cost });
        lot.qty -= n;
        if (lot.cost != null) lot.cost -= cost;
        qty -= n;
        if (lot.qty <= EPS) lots.shift();
      }
      if (qty > EPS) consumed.push({ qty, cost: null });
      return consumed;
    }
    for (const e of rows) {
      if (e.kind === "buy") {
        buys++;
        const cost = e.amountSol != null && e.feeSol != null
          ? e.amountSol + e.feeSol : null;
        if (cost == null) reasons.add("missing_quote_or_fee");
        lots.push({ qty: e.amountTokens, cost });
      } else if (e.kind === "transfer_in") {
        transfers++;
        lots.push({ qty: e.amountTokens, cost: null });
        reasons.add("incoming_transfer_unknown_basis");
      } else if (e.kind === "transfer_out") {
        transfers++;
        if (consume(e.amountTokens).some(m => m.cost == null)) {
          reasons.add("outgoing_transfer_without_basis"); basisTainted = true;
        }
      } else if (e.kind === "sell") {
        sells++;
        const matches = consume(e.amountTokens);
        const allKnown = matches.every(m => m.cost != null);
        if (!basisTainted && allKnown && e.amountSol != null && e.feeSol != null) {
          knownPnl += e.amountSol - e.feeSol - matches.reduce((sum,m) => sum + m.cost, 0);
          knownSellCount++;
        } else reasons.add("sale_without_verified_cost_basis");
      } else {
        reasons.add("unpriced_or_undecoded_activity");
        basisTainted = true;
        // Any subsequent cost-basis computation may be invalid: do not
        // fabricate a quantity or a direction from incomplete decoding.
      }
    }
    const verifiedTotal = coverageComplete && reasons.size === 0 && sells > 0;
    results.push({ mint, buys, sells, transfers, activityCount: rows.length,
      knownSellCount, knownRealizedPnlSol: knownSellCount ? knownPnl : null,
      totalRealizedPnlSol: verifiedTotal ? knownPnl : null,
      status: verifiedTotal ? "verified" : "unknown",
      reasons: [...reasons].length ? [...reasons] : sells ? [] : ["no_sales"] });
  }
  return results;
}

/**
 * Stream a pre-ordered SQL evidence cursor (mint, slot, block_time, signature,
 * leg_index). Retains only open FIFO lots for the current mint, not all wallet
 * transactions; the legacy computePnl remains an independent test oracle.
 */
function computePnlOrdered(ordered, coverageComplete) {
  const results = [];
  let s = null;
  const finish = () => {
    if (!s) return;
    const verifiedTotal = coverageComplete && s.reasons.size === 0 && s.sells > 0;
    results.push({ mint: s.mint, buys: s.buys, sells: s.sells,
      transfers: s.transfers, activityCount: s.activityCount,
      knownSellCount: s.knownSellCount,
      knownRealizedPnlSol: s.knownSellCount ? s.knownPnl : null,
      totalRealizedPnlSol: verifiedTotal ? s.knownPnl : null,
      status: verifiedTotal ? "verified" : "unknown",
      reasons: s.reasons.size ? [...s.reasons] : s.sells ? [] : ["no_sales"] });
  };
  const consume = (qty) => {
    const consumed = [];
    while (qty > EPS && s.lotHead < s.lots.length) {
      const lot = s.lots[s.lotHead], n = Math.min(qty, lot.qty);
      const cost = lot.cost == null ? null : lot.cost * n / lot.qty;
      consumed.push({ qty: n, cost });
      lot.qty -= n;
      if (lot.cost != null) lot.cost -= cost;
      qty -= n;
      if (lot.qty <= EPS) s.lotHead++;
    }
    if (s.lotHead > 1024 && s.lotHead * 2 >= s.lots.length) {
      s.lots = s.lots.slice(s.lotHead); s.lotHead = 0;
    }
    if (qty > EPS) consumed.push({ qty, cost: null });
    return consumed;
  };
  for (const e of ordered) {
    if (!e.mint || e.mint === WSOL) continue;
    if (s && e.mint < s.mint) throw new Error("Evidence iterator is not mint-ordered");
    if (!s || e.mint !== s.mint) {
      finish();
      s = { mint: e.mint, reasons: new Set(coverageComplete ? [] : ["history_incomplete"]),
        basisTainted: !coverageComplete, lots: [], lotHead: 0, prev: null,
        knownPnl: 0, knownSellCount: 0, buys: 0, sells: 0, transfers: 0, activityCount: 0 };
    }
    s.activityCount++;
    if (e.slot == null || e.timestamp == null) {
      s.reasons.add("missing_order_metadata");
      s.basisTainted = true;
    }
    if (s.prev && e.slot != null && e.slot === s.prev.slot &&
        e.signature !== s.prev.signature) {
      s.reasons.add("same_slot_order_unverified");
      s.basisTainted = true;
    }
    s.prev = {slot: e.slot,signature: e.signature};
    if (e.kind === "buy") {
      s.buys++;
      const cost = e.amountSol != null && e.feeSol != null
        ? e.amountSol + e.feeSol : null;
      if (cost == null) s.reasons.add("missing_quote_or_fee");
      s.lots.push({qty: e.amountTokens, cost});
    } else if (e.kind === "transfer_in") {
      s.transfers++;
      s.lots.push({qty: e.amountTokens, cost: null});
      s.reasons.add("incoming_transfer_unknown_basis");
    } else if (e.kind === "transfer_out") {
      s.transfers++;
      if (consume(e.amountTokens).some(m => m.cost == null)) {
        s.reasons.add("outgoing_transfer_without_basis");
        s.basisTainted = true;
      }
    } else if (e.kind === "sell") {
      s.sells++;
      const matches = consume(e.amountTokens);
      const allKnown = matches.every(m => m.cost != null);
      if (!s.basisTainted && allKnown && e.amountSol != null && e.feeSol != null) {
        s.knownPnl += e.amountSol - e.feeSol -
          matches.reduce((sum,m) => sum + m.cost, 0);
        s.knownSellCount++;
      } else s.reasons.add("sale_without_verified_cost_basis");
    } else {
      s.reasons.add("unpriced_or_undecoded_activity");
      s.basisTainted = true;
    }
  }
  finish();
  return results;
}
module.exports = { parseEvidence, computePnl, computePnlOrdered, WSOL };
