"use strict";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const DISCRIMINATOR = Buffer.from("bddb7fd34ee661ee", "hex");
function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt("0x" + bytes.toString("hex")), result = "";
  while (value) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = "1" + result; }
  return result;
}
// Stable TradeEvent prefix from pump-fun/pump-public-docs/idl/pump.json.
// Only accept data emitted while the canonical Pump program is executing.
function pumpEvents(raw) {
  const events = [], stack = [];
  for (const line of raw?.meta?.logMessages || []) {
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) { stack.length = Number(invoke[2]) - 1; stack.push(invoke[1]); continue; }
    const exit = /^Program (\w+) (?:success|failed:.*)$/.exec(line);
    if (exit) { if (stack.at(-1) !== exit[1]) return []; stack.pop(); continue; }
    if (stack.at(-1) !== PUMP || !line.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(line.slice(14), "base64");
    if (!bytes.subarray(0, 8).equals(DISCRIMINATOR)) continue;
    if (bytes.length < 129 || bytes[56] > 1) return [];
    events.push({ mint: base58(bytes.subarray(8, 40)), solRaw: bytes.readBigUInt64LE(40),
      tokenRaw: bytes.readBigUInt64LE(48), buy: bytes[56] === 1,
      protocolUser: base58(bytes.subarray(57, 89)) });
  }
  return events;
}
function tokenAccounts(tx, mint) {
  const map = new Map();
  for (const entry of [...(tx.raw.meta.preTokenBalances || []), ...(tx.raw.meta.postTokenBalances || [])]) {
    const key = tx.accountKeys?.[entry.accountIndex];
    if (key && entry.mint === mint && entry.owner) map.set(key, entry.owner);
  }
  return map;
}
function hasPath(edges, starts, ends, ownerByAccount, protocolUser) {
  // An exact-amount checked-transfer chain must cross the protocol's user account.
  const visit = (node, seen, includesUser, after = -1) => {
    const user = includesUser || ownerByAccount.get(node) === protocolUser;
    if (ends.has(node) && seen.size > 1) return user;
    if (seen.size > 8) return false;
    return edges.some((e,index) => index > after && e.source === node && !seen.has(e.destination)
      && visit(e.destination, new Set([...seen, e.destination]), user, index));
  };
  return [...starts].some(start => visit(start, new Set([start]), false));
}
// Checked/unchecked SPL cash flows, resolved from transaction account metadata.
function cashFlow(tx, instructions, mint, owner) {
  const owners = tokenAccounts(tx, mint);
  let delta = 0n;
  for (const ix of instructions) {
    if (!TOKEN_PROGRAMS.has(ix.programId)) continue;
    const info = ix.parsed?.info;
    if (!info || !["transfer", "transferChecked"].includes(ix.parsed.type)) continue;
    if (ix.parsed.type === "transferChecked" ? info.mint !== mint : !owners.has(info.source) && !owners.has(info.destination)) continue;
    const amount = info.tokenAmount?.amount ?? info.amount;
    if (!/^\d+$/.test(String(amount))) return null;
    if (owners.get(info.source) === owner) delta -= BigInt(amount);
    if (owners.get(info.destination) === owner) delta += BigInt(amount);
  }
  return delta;
}
function routePrefix(data) {
  if (typeof data !== "string" || data.length > 100) return "";
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of data) { const v = alphabet.indexOf(c); if (v < 0) return ""; n = n * 58n + BigInt(v); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  return bytes.length === 57 ? bytes.subarray(0, 8).toString("hex") : "";
}
function splitBuy(tx, mint, event, deltas, signers) {
  if (!event.buy || deltas.length !== 3) return null;
  const negative = deltas.filter(d => BigInt(d.deltaRaw) < 0n), positive = deltas.filter(d => BigInt(d.deltaRaw) > 0n);
  if (negative.length !== 1 || positive.length !== 2 || BigInt(negative[0].deltaRaw) !== -event.tokenRaw
      || positive.reduce((n,d) => n + BigInt(d.deltaRaw), 0n) !== event.tokenRaw) return null;
  const owners = tokenAccounts(tx, mint), matches = [];
  for (const group of tx.raw.meta.innerInstructions || []) {
    const ix = tx.raw.transaction.message.instructions[group.index], a = ix?.accounts;
    // Pin the observed canonical router SwapTob ABI; never select the largest recipient.
    if (ix?.programId !== "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u" || routePrefix(ix.data) !== "aa2955b184501f35"
        || !a || a[4] !== mint || !signers.has(a[0])) continue;
    const quoteOwners = tokenAccounts(tx, a[3]);
    if (quoteOwners.get(a[1]) !== a[0]) continue;
    const trader = positive.find(d => d.owner === owners.get(a[2]));
    if (!trader) continue;
    const transfers = group.instructions.filter(x => TOKEN_PROGRAMS.has(x.programId) && x.parsed?.type === "transferChecked"
      && x.parsed.info.mint === mint).map(x => x.parsed.info);
    if (transfers.length !== 3) continue;
    const [input, ...outputs] = transfers;
    if (owners.get(input.source) !== negative[0].owner || owners.get(input.destination) !== event.protocolUser
        || input.tokenAmount.amount !== String(event.tokenRaw)) continue;
    if (!outputs.every(o => o.source === input.destination && o.authority === event.protocolUser
      && positive.some(d => d.owner === owners.get(o.destination) && d.deltaRaw === o.tokenAmount.amount))) continue;
    if (new Set(outputs.map(o=>o.destination)).size !== 2
        || new Set(outputs.map(o=>owners.get(o.destination))).size !== 2
        || !outputs.some(o => o.destination === a[2])) continue;
    if (outputs.reduce((n,o)=>n+BigInt(o.tokenAmount.amount),0n) !== event.tokenRaw) continue;
    const deduction = positive.find(d => d.owner !== trader.owner);
    matches.push({ trader, pool: negative[0], group, quoteOwner: a[0], quoteMint: a[3],
      tokenDeduction: { owner: deduction.owner, amountRaw: deduction.deltaRaw }, grossTokenAmountRaw: String(event.tokenRaw) });
  }
  return matches.length === 1 ? matches[0] : null;
}
function decodePumpSwap(tx, mint) {
  if (tx?.transactionError !== null || tx.raw?.meta?.err !== null || !Number.isSafeInteger(tx.slot)) return null;
  const raw = tx.raw;
  if (raw.transaction?.signatures?.[0] !== tx.signature) return null;
  const events = pumpEvents(raw).filter(e => e.mint === mint);
  // One canonical token_trades row cannot safely represent multiple swap legs.
  if (events.length !== 1) return null;
  const event = events[0];
  if (event.solRaw <= 0n || event.tokenRaw <= 0n || event.solRaw > BigInt(Number.MAX_SAFE_INTEGER)
      || event.tokenRaw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const keys = raw.transaction.message.accountKeys;
  const signers = new Set(keys.filter(k => k?.signer === true).map(k => k.pubkey));
  const deltas = (tx.tokenBalanceDeltas || []).filter(d => d.mint === mint && d.deltaRaw !== "0");
  if (deltas.some(d => !d.owner || !/^-?\d+$/.test(d.deltaRaw))) return null;
  const signedAmount = event.buy ? event.tokenRaw : -event.tokenRaw;
  const split = splitBuy(tx, mint, event, deltas, signers);
  const candidates = deltas.filter(d => signers.has(d.owner) && BigInt(d.deltaRaw) === signedAmount);
  if (!split && (deltas.length !== 2 || candidates.length !== 1)) return null;
  const trader = split ? split.trader : candidates[0];
  const pools = deltas.filter(d => d.owner !== trader.owner && BigInt(d.deltaRaw) === -signedAmount);
  if (pools.length !== 1 || !Number.isInteger(trader.decimals) || trader.decimals < 0 || trader.decimals > 18) return null;
  const pool = pools[0], owners = tokenAccounts(tx, mint);
  const userAccounts = new Set([...owners].filter(([, owner]) => owner === trader.owner).map(([a]) => a));
  const poolAccounts = new Set([...owners].filter(([, owner]) => owner === pool.owner).map(([a]) => a));
  const provenGroups = split ? [split.group] : [];
  for (const group of raw.meta.innerInstructions || []) {
    const outer = raw.transaction.message.instructions[group.index];
    if (outer?.programId !== PUMP && !group.instructions.some(ix => ix.programId === PUMP)) continue;
    const transfers = group.instructions.filter(ix => TOKEN_PROGRAMS.has(ix.programId)
      && ix.parsed?.type === "transferChecked" && ix.parsed.info.mint === mint
      && ix.parsed.info.tokenAmount?.amount === String(event.tokenRaw)).map(ix => ix.parsed.info);
    if (hasPath(transfers, event.buy ? poolAccounts : userAccounts, event.buy ? userAccounts : poolAccounts,
      owners, event.protocolUser)) provenGroups.push(group);
  }
  if (!provenGroups.length) return null;
  // A routed sell may settle in USDC rather than SOL. Do not pretend the
  // protocol's intermediate SOL leg is the seller's received quote.
  const quoteOwner = split ? split.quoteOwner : trader.owner;
  const quoteDeltas = (tx.tokenBalanceDeltas || []).filter(d => d.owner === quoteOwner
    && d.mint !== mint && /^-?\d+$/.test(d.deltaRaw) && BigInt(d.deltaRaw) !== 0n);
  let routeQuoteDelta = null;
  let quoteMint = SOL, quoteAmount = Number(event.solRaw) / 1e9, quoteDecimals = 9;
  if (quoteDeltas.length) {
    if (quoteDeltas.length !== 1) return null;
    const quote = quoteDeltas[0], amount = BigInt(quote.deltaRaw);
    if ((event.buy ? amount >= 0n : amount <= 0n) || !Number.isInteger(quote.decimals)
        || quote.decimals < 0 || quote.decimals > 18 || (amount < 0n ? -amount : amount) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    if (split && quote.mint !== split.quoteMint) return null;
    const all = [...raw.transaction.message.instructions, ...(raw.meta.innerInstructions || []).flatMap(g=>g.instructions)];
    if (cashFlow(tx, all, quote.mint, quoteOwner) !== amount) return null;
    const routeFlows = provenGroups.map(g => cashFlow(tx,g.instructions,quote.mint,quoteOwner));
    if (routeFlows.some(n => n === null)) return null;
    const routeAmount = routeFlows.reduce((a,b) => a+b,0n);
    if (event.buy ? routeAmount >= 0n : routeAmount <= 0n) return null;
    const absolute = routeAmount < 0n ? -routeAmount : routeAmount;
    if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    routeQuoteDelta = routeAmount;
    quoteMint = quote.mint; quoteDecimals = quote.decimals;
    quoteAmount = Math.abs(Number(routeQuoteDelta)) / 10 ** quoteDecimals;
  } else {
    const index = tx.accountKeys.indexOf(trader.owner);
    const delta = tx.postBalances[index] - tx.preBalances[index];
    if (!Number.isFinite(delta) || (event.buy ? delta >= 0 : delta <= 0)) return null;
  }
  const amountTokens = Math.abs(Number(trader.deltaRaw)) / 10 ** trader.decimals;
  const amountSol = quoteMint === SOL ? quoteAmount : 0;
  return { signature: tx.signature, timestamp: tx.timestamp, slot: tx.slot, trader: trader.owner,
    type: event.buy ? "buy" : "sell", amountTokens, amountSol, priceSol: amountSol / amountTokens,
    quoteMint, quoteAmount, quoteDecimals, fee: Number(raw.meta.fee || 0) / 1e9,
    feeLamports: Number(raw.meta.fee || 0), source: "alchemy", decoderCoverage: "swap_only",
    attribution: "pump_event_and_checked_transfer_path", protocolTrader: event.protocolUser,
    protocolAmountSol: Number(event.solRaw) / 1e9,
    ...(quoteDeltas.length ? { quoteWalletDeltaRaw: quoteDeltas[0].deltaRaw,
      quoteRouteDeltaRaw: String(routeQuoteDelta),
      quoteExternalDeltaRaw: String(BigInt(quoteDeltas[0].deltaRaw) - routeQuoteDelta) } : {}),
    ...(split ? { fundedBy: split.quoteOwner, grossTokenAmountRaw: split.grossTokenAmountRaw,
      tokenDeductions: [split.tokenDeduction], attribution: "router_swap_tob_recipient_and_split_transfer_ledger" } : {}) };
}
module.exports = { decodePumpSwap, pumpEvents };
