"use strict";
// Offline arithmetic check on full Solana RPC meta.preBalances/postBalances.
// Does not prove transaction finality or individual fee recipients.
function exactAtomic(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && /^\d{1,40}$/.test(v)) return BigInt(v);
  return null;
}
function inspectNativeBalances(meta) {
  const pre = meta?.preBalances;
  const post = meta?.postBalances;
  const fee = exactAtomic(meta?.fee);
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length === 0 || pre.length !== post.length) {
    return {status:"UNAVAILABLE",reason:"missing_or_incomplete_balance_arrays",deltaLamports:null};
  }
  if (fee === null) return {status:"UNAVAILABLE",reason:"invalid_network_fee",deltaLamports:null};
  let delta = 0n;
  for (let i = 0; i < pre.length; i++) {
    const before = exactAtomic(pre[i]), after = exactAtomic(post[i]);
    if (before === null || after === null)
      return {status:"UNAVAILABLE",reason:"unsafe_or_invalid_lamport_balance",deltaLamports:null};
    delta += after - before;
  }
  const observed = delta.toString();
  if (delta !== -fee) return {status:"MISMATCH",reason:"native_balance_conservation_mismatch",deltaLamports:observed};
  return {status:"MATCH",reason:"balance_sum_matches_reported_fee",deltaLamports:observed};
}
module.exports={exactAtomic,inspectNativeBalances};
