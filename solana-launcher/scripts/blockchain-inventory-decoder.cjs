"use strict";

// Conservative inventory evidence decoder for Alchemy jsonParsed transactions.
// This emits inventory movements, NOT trades or PnL inputs. Unknown ownership
// remains unknown; transfer/mint/burn evidence must not be inferred from a swap.
const TRANSFER_TYPES = new Set(["transfer", "transferChecked"]);
const MINT_TYPES = new Set(["mintTo", "mintToChecked"]);
const BURN_TYPES = new Set(["burn", "burnChecked"]);

function amountParts(info) {
  const tokenAmount = info?.tokenAmount || info?.amount;
  if (tokenAmount && typeof tokenAmount === "object") {
    const raw = tokenAmount.amount ?? tokenAmount.tokenAmount;
    const decimals = Number(tokenAmount.decimals);
    if (raw != null && Number.isFinite(decimals) && decimals >= 0) {
      return { raw: String(raw), decimals };
    }
  }
  const raw = info?.amount;
  if (raw != null && /^\d+$/.test(String(raw))) {
    return { raw: String(raw), decimals: Number.isFinite(Number(info.decimals)) ? Number(info.decimals) : null };
  }
  return { raw: null, decimals: null };
}

function decodeInventoryMovements(tx) {
  if (!tx || typeof tx.signature !== "string" || !tx.signature) return [];
  const ops = Array.isArray(tx.decodedOperations) ? tx.decodedOperations : [];
  const balances = Array.isArray(tx.tokenBalanceDeltas) ? tx.tokenBalanceDeltas : [];
  const ownerByTokenAccount = new Map();
  const balanceByTokenAccount = new Map();
  for (const b of balances) {
    if (!b?.tokenAccount) continue;
    if (b.owner) ownerByTokenAccount.set(b.tokenAccount, b.owner);
    // Pre/post balance deltas may contain the same account twice; mint and
    // decimals are stable for a token account, so retaining either is safe.
    if (!balanceByTokenAccount.has(b.tokenAccount)) balanceByTokenAccount.set(b.tokenAccount, b);
  }
  const movements = [];
  for (let operationIndex = 0; operationIndex < ops.length; operationIndex++) {
    const op = ops[operationIndex];
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
      (Number.isFinite(Number(accountBalance?.decimals)) ? Number(accountBalance.decimals) : null);
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
      slot: Number.isFinite(Number(tx.slot)) ? Number(tx.slot) : null,
      blockTime: Number.isFinite(Number(tx.timestamp)) ? Number(tx.timestamp) : null,
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
      attributionStatus: owner ? "owner_resolved" : "owner_unknown",
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
