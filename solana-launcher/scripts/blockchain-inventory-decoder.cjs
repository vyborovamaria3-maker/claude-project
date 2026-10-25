"use strict";

// Conservative inventory evidence decoder for Alchemy jsonParsed transactions.
// This emits inventory movements, NOT trades or PnL inputs. Unknown ownership
// remains unknown; transfer/mint/burn evidence must not be inferred from a swap.
const TRANSFER_TYPES = new Set(["transfer", "transferChecked"]);
const MINT_TYPES = new Set(["mintTo", "mintToChecked"]);
const TOKEN_PROGRAMS = new Set(["spl-token", "spl-token-2022", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const BURN_TYPES = new Set(["burn", "burnChecked"]);

function exactRaw(value) {
  if (typeof value === "string" && /^\d{1,40}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null; // Never stringify an unsafe floating-point token amount.
}
function exactDecimals(value) {
  const v = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return Number.isInteger(v) && v >= 0 && v <= 255 ? v : null;
}
function amountParts(info) {
  const tokenAmount = info?.tokenAmount || info?.amount;
  if (tokenAmount && typeof tokenAmount === "object") {
    return { raw: exactRaw(tokenAmount.amount ?? tokenAmount.tokenAmount),
      decimals: exactDecimals(tokenAmount.decimals) };
  }
  return { raw: exactRaw(info?.amount), decimals: exactDecimals(info?.decimals) };
}

function decodeInventoryMovements(tx) {
  if (!tx || typeof tx.signature !== "string" || !tx.signature || tx.transactionError !== null) return [];
  const ops = Array.isArray(tx.decodedOperations) ? tx.decodedOperations : [];
  const balances = Array.isArray(tx.tokenBalanceDeltas) ? tx.tokenBalanceDeltas : [];
  const ownerByTokenAccount = new Map();
  const ownerConflicts = new Set();
  const balanceByTokenAccount = new Map();
  const balanceConflicts = new Set();
  function putOwner(account, owner) {
    if(!account || !owner || ownerConflicts.has(account)) return;
    const prev=ownerByTokenAccount.get(account);
    if(prev && prev!==owner) { ownerByTokenAccount.delete(account); ownerConflicts.add(account); }
    else ownerByTokenAccount.set(account,owner);
  }
  function putBalance(account, mint, decimals) {
    if(!account || balanceConflicts.has(account)) return;
    const prev=balanceByTokenAccount.get(account);
    const d=exactDecimals(decimals);
    if(prev && ((mint && prev.mint && prev.mint!==mint) ||
      (d!==null && prev.decimals!==null && prev.decimals!==d))) {
      balanceByTokenAccount.delete(account);balanceConflicts.add(account);return;
    }
    balanceByTokenAccount.set(account,{mint:mint||prev?.mint||null,
      decimals:d ?? prev?.decimals ?? null});
  }
  for (const b of balances) {
    if (!b?.tokenAccount) continue;
    putOwner(b.tokenAccount,b.owner);
    putBalance(b.tokenAccount,b.mint,b.decimals);
  }
  // Owner-level deltas aggregate multiple token accounts. Recover account-level
  // metadata from the retained pre/post balances before inferring transfer owners.
  for (const b of [...(tx.preTokenBalances || []), ...(tx.postTokenBalances || [])]) {
    const account = Number.isInteger(b.accountIndex) ? tx.accountKeys?.[b.accountIndex] : null;
    if (!account) continue;
    putOwner(account,b.owner);
    putBalance(account,b.mint,b.uiTokenAmount?.decimals);
  }
  const movements = [];
  for (let operationIndex = 0; operationIndex < ops.length; operationIndex++) {
    const op = ops[operationIndex];
    if (!TOKEN_PROGRAMS.has(op?.programId || op?.program)) continue;
    const info = op?.info || {};
    const type = String(op?.type || "");
    if (!TRANSFER_TYPES.has(type) && !MINT_TYPES.has(type) && !BURN_TYPES.has(type)) continue;
    const amount = amountParts(info);
    const sourceAccount = info.source || info.account || null;
    const destinationAccount = info.destination || null;
    const sourceBalance = sourceAccount ? balanceByTokenAccount.get(sourceAccount) : null;
    const destinationBalance = destinationAccount ? balanceByTokenAccount.get(destinationAccount) : null;
    const accountBalance = sourceBalance || destinationBalance;
    // SPL Token's unchecked transfer instruction does not include mint or
    // decimals. Resolve them only from the matching transaction token account.
    const mint = typeof info.mint === "string" ? info.mint : accountBalance?.mint || null;
    const decimals = amount.decimals != null ? amount.decimals :
      (accountBalance?.decimals != null && Number.isFinite(Number(accountBalance.decimals)) ? Number(accountBalance.decimals) : null);
    const sourceOwner = sourceAccount ? ownerByTokenAccount.get(sourceAccount) || null : null;
    const destinationOwner = destinationAccount ? ownerByTokenAccount.get(destinationAccount) || null : null;
    let kind;
    if (TRANSFER_TYPES.has(type)) kind = "transfer";
    else if (MINT_TYPES.has(type)) kind = "mint";
    else kind = "burn";
    // transfer instructions can be present without enough parsed fields to
    // identify the mint/amount. Keep the row with null amount for diagnostics.
    const add = (owner, direction, account) => movements.push({
      signature: tx.signature,
      slot: Number.isSafeInteger(tx.slot) && tx.slot >= 0 ? tx.slot : null,
      blockTime: Number.isSafeInteger(tx.timestamp) && tx.timestamp >= 0 ? tx.timestamp : null,
      operationIndex,
      operationType: type,
      kind,
      direction,
      owner: owner || null,
      tokenAccount: account || null,
      mint,
      amountRaw: amount.raw,
      decimals,
      sourceAccount,
      destinationAccount,
      sourceOwner,
      destinationOwner,
      authority: typeof info.authority === "string" ? info.authority : null,
      provider: "alchemy",
      decoderVersion: "inventory-v1",
      attributionStatus: owner ? "owner_resolved"
        : ownerConflicts.has(account) ? "owner_conflict" : "owner_unknown",
    });
    if (kind === "transfer") {
      add(sourceOwner, "out", sourceAccount);
      add(destinationOwner, "in", destinationAccount);
      // A self-transfer can resolve to the same owner. Keep both legs as
      // instruction evidence; downstream accounting can net them explicitly.
    } else if (kind === "mint") {
      add(destinationOwner || (typeof info.account === "string" ? ownerByTokenAccount.get(info.account) : null),
        "in", destinationAccount || info.account || null);
    } else {
      add(sourceOwner || (typeof info.account === "string" ? ownerByTokenAccount.get(info.account) : null),
        "out", sourceAccount || info.account || null);
    }
  }
  return movements;
}

module.exports = { decodeInventoryMovements };
