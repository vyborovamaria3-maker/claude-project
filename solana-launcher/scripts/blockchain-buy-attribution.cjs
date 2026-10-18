"use strict";
const TOKENS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
// Deliberately narrow: a routed BUY with one signing, paying final recipient.
// This is evidence-based repair, not a general signer=trader heuristic.
function resolveRoutedBuy(trade, event) {
  const no = reason => ({ status: "unresolved", reason });
  if (trade.type !== "buy" || trade.source !== "pump") return no("unsupported_trade");
  if (event.signature !== trade.signature || event.transactionError !== null || event.raw?.meta?.err !== null) return no("unverified_execution");
  const deltas = (event.tokenBalanceDeltas || []).filter(d => d.mint === trade.mint);
  const prior = deltas.filter(d => d.owner === trade.trader);
  if (prior.length !== 1 || prior[0].deltaRaw !== "0" || !prior[0].tokenAccount) return no("not_zero_net_intermediary");
  const positive = deltas.filter(d => /^\d+$/.test(d.deltaRaw) && BigInt(d.deltaRaw) > 0n);
  if (positive.length !== 1) return no("ambiguous_recipients");
  const buyer = positive[0];
  if (!buyer.owner || !buyer.tokenAccount || buyer.owner === trade.trader) return no("unknown_recipient");
  const keys = event.raw?.transaction?.message?.accountKeys || [];
  const index = keys.findIndex(k => k.pubkey === buyer.owner && k.signer === true);
  if (index < 0 || !(event.preBalances[index] > event.postBalances[index])) return no("recipient_not_signing_payer");
  const amount = Number(buyer.deltaRaw) / 10 ** buyer.decimals;
  if (!Number.isFinite(amount) || Math.abs(amount - trade.amount_tokens) > Math.max(1e-9, amount * 1e-12)) return no("amount_mismatch");
  let proof;
  for (const group of event.raw?.meta?.innerInstructions || []) {
    const transfers = group.instructions.filter(ix => TOKENS.has(ix.programId) && ix.parsed?.type === "transferChecked").map(ix => ix.parsed.info);
    for (let i = 0; i < transfers.length; i++) {
      const incoming = transfers[i];
      if (incoming.mint !== trade.mint || incoming.destination !== prior[0].tokenAccount || incoming.tokenAmount?.amount !== buyer.deltaRaw) continue;
      const outgoing = transfers.slice(i+1).find(ix => ix.mint === trade.mint && ix.source === prior[0].tokenAccount
        && ix.destination === buyer.tokenAccount && ix.authority === trade.trader && ix.tokenAmount?.amount === buyer.deltaRaw);
      const pool = deltas.find(d => d.tokenAccount === incoming.source && d.owner && d.owner !== buyer.owner
        && /^-\d+$/.test(d.deltaRaw) && BigInt(d.deltaRaw) === -BigInt(buyer.deltaRaw));
      const paid = group.instructions.some(ix => ix.programId === "11111111111111111111111111111111"
        && ix.parsed?.type === "transfer" && ix.parsed.info.source === trade.trader
        && ix.parsed.info.destination === pool?.owner
        && Math.abs(ix.parsed.info.lamports / 1e9 - trade.amount_sol) < 1e-12);
      if (outgoing && pool && paid) proof = { outerInstruction: group.index, poolTokenAccount: incoming.source,
        intermediaryTokenAccount: prior[0].tokenAccount, recipientTokenAccount: buyer.tokenAccount, amountRaw: buyer.deltaRaw };
    }
  }
  if (!proof) return no("transfer_and_payment_chain_not_proven");
  return { status: "confirmed_routed_buyer", previousTrader: trade.trader, trader: buyer.owner, signature: trade.signature, mint: trade.mint, proof };
}
function repair(db, mint, signature) {
  return db.transaction(() => {
    const { gunzipSync } = require("node:zlib");
    const trade = db.prepare("SELECT * FROM token_trades WHERE mint=? AND signature=?").get(mint, signature);
    const raw = db.prepare("SELECT payload_gzip FROM chain_seed_events WHERE kind='token' AND address=? AND signature=?").get(mint, signature);
    if (!trade || !raw) throw new Error("Trade/evidence missing");
    const result = resolveRoutedBuy(trade, JSON.parse(gunzipSync(raw.payload_gzip)));
    if (result.status !== "confirmed_routed_buyer") throw new Error(result.reason);
    db.exec(`CREATE TABLE IF NOT EXISTS chain_trade_attribution_repairs (
      mint TEXT NOT NULL, signature TEXT NOT NULL, previous_row_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL, repaired_at INTEGER NOT NULL, PRIMARY KEY(mint,signature))`);
    db.prepare("INSERT INTO chain_trade_attribution_repairs VALUES(?,?,?,?,?)")
      .run(mint, signature, JSON.stringify(trade), JSON.stringify(result), Date.now());
    const changed = db.prepare("UPDATE token_trades SET trader=? WHERE mint=? AND signature=? AND trader=?")
      .run(result.trader, mint, signature, result.previousTrader);
    if (changed.changes !== 1) throw new Error("Trade changed concurrently");
    return result;
  }).immediate();
}
module.exports = { resolveRoutedBuy, repair };
