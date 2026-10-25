"use strict";

// Diagnostic-only account-level Token/SPL movement reconciliation.
// Never infers missing pre/post balances as zero; never writes trades, inventory lots,
// FIFO cost basis, or PnL. This is local arithmetic, not blockchain finality proof.
const { decodeInventoryMovements } = require("./blockchain-inventory-decoder.cjs");
const VERSION = "inventory-reconciliation-v1";
function atomic(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\d{1,40}$/.test(value)) return BigInt(value);
  return null;
}
function decimal(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}
function readAccountKeys(tx) {
  const raw=tx?.raw?.transaction?.message?.accountKeys || tx?.raw?.message?.accountKeys || [];
  const keys=Array.isArray(tx?.accountKeys) && tx.accountKeys.length ? tx.accountKeys : raw;
  if(!Array.isArray(keys)) return [];
  return keys.map(a=>typeof a==="string"?a:a?.pubkey||null);
}
function parseBalances(rows, keys, side) {
  const out=new Map(), issues=[];
  if(!Array.isArray(rows)) return {out,issues:[side+"_balance_array_missing"]};
  for (const row of rows) {
    const idx=row?.accountIndex;
    if (!Number.isSafeInteger(idx) || idx<0 || idx>=keys.length || typeof keys[idx]!=="string" || !keys[idx]) {
      issues.push(side+"_invalid_account_index"); continue;
    }
    if(out.has(idx)){issues.push(side+"_duplicate_account_index");continue;}
    const qty=atomic(row.uiTokenAmount?.amount);
    const decimals=decimal(row.uiTokenAmount?.decimals);
    const mint=typeof row.mint==="string"&&row.mint ?row.mint:null;
    const owner=typeof row.owner==="string"&&row.owner?row.owner:null;
    out.set(idx,{account:keys[idx],accountIndex:idx,mint,owner,decimals,rawAmount:qty});
    if(qty===null)issues.push(side+"_invalid_atomic_amount");
    if(!mint)issues.push(side+"_unknown_mint");
    if(decimals===null)issues.push(side+"_unknown_decimals");
  }
  return {out,issues};
}
function reconcileInventoryEvidence(tx) {
  const base={signature:tx?.signature||null,version:VERSION,authority:"diagnostic_only",
    fullHistoryComplete:false,financialLedgerEligible:false,accountRows:[],
    movementsSeen:0,issues:[],counts:{MATCH:0,MISMATCH:0,PARTIAL:0,CONFLICT:0},status:"UNKNOWN"};
  if(typeof tx?.signature!=="string"||!tx.signature){base.issues.push("invalid_signature");return base;}
  if(tx.transactionError===undefined || tx.transactionError!==null || tx.raw?.meta?.err!==null && tx.raw?.meta?.err!==undefined) {
    base.status=tx.transactionError===undefined?"UNKNOWN_EXECUTION":"FAILED_EXECUTION";
    base.issues.push("execution_not_proven_successful");return base;
  }
  const keys=readAccountKeys(tx);
  if(!keys.length){base.issues.push("missing_account_keys");return base;}
  const pre=parseBalances(tx.preTokenBalances,keys,"pre");
  const post=parseBalances(tx.postTokenBalances,keys,"post");
  base.issues.push(...pre.issues,...post.issues);
  if(!Array.isArray(tx.preTokenBalances)||!Array.isArray(tx.postTokenBalances)){return base;}
  const movements=decodeInventoryMovements(tx);
  base.movementsSeen=movements.length;
  const moveByAccount=new Map(), unknownMoves=[];
  for(const m of movements){
    const acc=m?.tokenAccount;
    const amount=atomic(m?.amountRaw);
    if(typeof acc!=="string"||!acc||!keys.includes(acc)){
      unknownMoves.push("movement_account_unresolved");continue;
    }
    if(!["in","out"].includes(m.direction)||amount===null||!m.mint){
      unknownMoves.push("movement_amount_mint_or_direction_unknown");continue;
    }
    const x=moveByAccount.get(acc)||{deltas:new Map(),legs:0};
    const signed=m.direction==="in"?amount:-amount;
    x.deltas.set(m.mint,(x.deltas.get(m.mint)||0n)+signed);
    x.legs++;moveByAccount.set(acc,x);
  }
  base.issues.push(...unknownMoves);
  // Any missing or malformed movement makes the overall result PARTIAL, not MATCH.
  const indices=new Set([...pre.out.keys(),...post.out.keys()]);
  for(const acc of moveByAccount.keys()){
    const idx=keys.indexOf(acc);
    if(idx>=0) indices.add(idx);
  }
  const priority={MATCH:0,PARTIAL:1,MISMATCH:2,CONFLICT:3};
  for(const idx of [...indices].sort((a,b)=>a-b)){
    const before=pre.out.get(idx),after=post.out.get(idx);
    const acct=before?.account||after?.account||keys[idx]||null;
    const move=moveByAccount.get(acct);
    const row={account:acct,accountIndex:idx,mint:before?.mint||after?.mint||null,
      owner:before?.owner||after?.owner||null,
      expectedDeltaAtomic:null,decodedDeltaAtomic:null,legCount:move?.legs||0,status:"PARTIAL",reason:"missing_pre_or_post_balance"};
    if(before && after) {
      if(before.mint && after.mint && before.mint!==after.mint) {
        row.status="CONFLICT";row.reason="mint_changed_for_token_account";
      } else if(before.owner && after.owner && before.owner!==after.owner) {
        row.status="CONFLICT";row.reason="owner_changed_across_balance_snapshots";
      } else if(before.decimals!==null && after.decimals!==null && before.decimals!==after.decimals) {
        row.status="CONFLICT";row.reason="decimals_changed_across_balance_snapshots";
      } else if(before.rawAmount===null||after.rawAmount===null||!row.mint||before.decimals===null||after.decimals===null){
        row.reason="missing_exact_balance_or_asset_metadata";
      } else if(!before.owner||!after.owner){
        row.reason="owner_unknown";
      } else {
        const delta=after.rawAmount-before.rawAmount;
        row.expectedDeltaAtomic=delta.toString();
        const others=[...(move?.deltas.keys()||[])].filter(mint=>mint!==row.mint);
        if(others.length){
          row.status="CONFLICT";row.reason="movement_mint_conflicts_with_balance_mint";
        }else{
          const observed=move?.deltas.get(row.mint)||0n;
          row.decodedDeltaAtomic=observed.toString();
          if(observed===delta) {row.status="MATCH";row.reason="decoded_movements_match_token_account_delta";}
          else {row.status="MISMATCH";row.reason="unreconciled_token_account_delta";}
        }
      }
    }
    base.counts[row.status]++;
    base.accountRows.push(row);
  }
  if(!base.accountRows.length){
    base.status=movements.length?"PARTIAL":"NO_TOKEN_EVIDENCE";
  } else if(base.counts.CONFLICT || base.issues.some(x=>x.includes("duplicate_account_index"))){
    base.status="CONFLICT";
  } else if(base.counts.MISMATCH) base.status="MISMATCH";
  else if(base.counts.PARTIAL||base.issues.length)base.status="PARTIAL";
  else base.status="OBSERVED_BALANCES_MATCH_MOVEMENTS";
  // Even a perfect local arithmetic match does not prove coverage/ownership history.
  return base;
}
module.exports={atomic,parseBalances,reconcileInventoryEvidence,VERSION};
