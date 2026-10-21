"use strict";

// Diagnostic-only facts from jsonParsed token-program instructions and pre/post
// token-account snapshots. Never derives a trade, PnL, or certified owner interval.
const TOKEN_PROGRAMS = new Set([
  "spl-token", "spl-token-2022",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WSOL = "So11111111111111111111111111111111111111112";
const INIT = new Set(["initializeAccount","initializeAccount2","initializeAccount3"]);
const FEE_OPS = new Set([
  "transferCheckedWithFee", "withdrawWithheldTokensFromMint",
  "withdrawWithheldTokensFromAccounts", "harvestWithheldTokensToMint",
  "setTransferFee"
]);
function atomic(v) {
  if (typeof v==="string" && /^\d{1,40}$/.test(v)) return BigInt(v);
  if (typeof v==="number" && Number.isSafeInteger(v) && v>=0) return BigInt(v);
  return null;
}
function accountKeys(tx) {
  if (!Array.isArray(tx?.accountKeys)) return [];
  return tx.accountKeys.map(x=>typeof x==="string"?x:(x?.pubkey||null));
}
function parseTokenSides(tx,side,keys,issues) {
  const rows=side==="PRE"?tx.preTokenBalances:tx.postTokenBalances;
  const byAccount=new Map();
  if (!Array.isArray(rows)) {
    issues.push(side+"_TOKEN_BALANCES_MISSING");
    return byAccount;
  }
  for(const b of rows) {
    const i=b?.accountIndex, address=Number.isSafeInteger(i)&&i>=0&&i<keys.length?keys[i]:null;
    if(typeof address!=="string"||!address) {issues.push(side+"_ACCOUNT_INDEX_INVALID");continue;}
    if(byAccount.has(address)) {issues.push(side+"_DUPLICATE_TOKEN_ACCOUNT");continue;}
    const owner=typeof b.owner==="string" && b.owner?b.owner:null;
    const mint=typeof b.mint==="string" && b.mint?b.mint:null;
    const quantity=atomic(b.uiTokenAmount?.amount);
    const decimals=b.uiTokenAmount?.decimals;
    if(!owner)issues.push(side+"_OWNER_UNKNOWN");
    if(!mint)issues.push(side+"_MINT_UNKNOWN");
    if(quantity===null)issues.push(side+"_AMOUNT_INVALID");
    if(!Number.isInteger(decimals)||decimals<0||decimals>255)
      issues.push(side+"_DECIMALS_UNKNOWN");
    byAccount.set(address,{account:address,index:i,owner,mint,amountAtomic:quantity,
      decimals:Number.isInteger(decimals)&&decimals>=0&&decimals<=255?decimals:null});
  }
  return byAccount;
}
function inspectLifecycle(tx) {
  const result={signature:tx?.signature||null,slot:Number.isSafeInteger(tx?.slot)?tx.slot:null,
    authority:"diagnostic_only",financialLedgerEligible:false,historyContinuityProven:false,
    ownerObservations:[],actions:[],issues:[]};
  if(typeof tx?.signature!=="string"||!tx.signature) {result.issues.push("SIGNATURE_UNKNOWN");return result;}
  if(tx.transactionError!==null || (tx.raw?.meta && tx.raw.meta.err!==null)) {
    result.issues.push(tx.transactionError===undefined?"EXECUTION_UNKNOWN":"EXECUTION_FAILED");
    return result;
  }
  if(result.slot===null){result.issues.push("SLOT_UNKNOWN");return result;}
  const keys=accountKeys(tx);
  if(!keys.length){result.issues.push("ACCOUNT_KEYS_MISSING");return result;}
  const pre=parseTokenSides(tx,"PRE",keys,result.issues);
  const post=parseTokenSides(tx,"POST",keys,result.issues);
  const allAccounts=new Set([...pre.keys(),...post.keys()]);
  for(const account of [...allAccounts].sort()) {
    const before=pre.get(account),after=post.get(account);
    if(before?.mint&&after?.mint&&before.mint!==after.mint) {
      result.issues.push("ACCOUNT_MINT_CONFLICT:"+account);continue;
    }
    if(before?.decimals!=null&&after?.decimals!=null&&before.decimals!==after.decimals) {
      result.issues.push("ACCOUNT_DECIMALS_CONFLICT:"+account);continue;
    }
    if(before?.owner&&after?.owner&&before.owner!==after.owner) {
      result.issues.push("SAME_TRANSACTION_OWNER_CHANGE:"+account);
    }
    const same=before?.owner&&after?.owner&&before.owner===after.owner;
    const add=(b,side)=>{if(b?.owner&&b?.mint)result.ownerObservations.push({
      account,slot:result.slot,owner:b.owner,mint:b.mint,
      side,observationStatus:side==="BOTH"?"CONSISTENT_PRE_POST":"ONE_SIDED_OR_CHANGED",
      continuityProven:false
    });};
    if(same && before?.mint===after?.mint) add(before,"BOTH");
    else {add(before,"PRE");add(after,"POST");}
  }
  const opList=Array.isArray(tx.decodedOperations)?tx.decodedOperations:[];
  if(opList.length>1500){result.issues.push("TOO_MANY_DECODED_OPERATIONS");return result;}
  for(let i=0;i<opList.length;i++) {
    const op=opList[i];
    if(!TOKEN_PROGRAMS.has(op?.programId||op?.program))continue;
    const type=String(op?.type||"");
    const info=op?.info||{};
    const account=info.account||info.source||null;
    if(typeof account!=="string"||!account) {
      if(INIT.has(type)||type==="closeAccount"||type==="syncNative"||type==="setAuthority"||FEE_OPS.has(type))
        result.issues.push("LIFECYCLE_ACCOUNT_UNKNOWN:"+i);
      continue;
    }
    const common={signature:tx.signature,slot:result.slot,operationIndex:i,account,
      mint:post.get(account)?.mint||pre.get(account)?.mint||null,
      owner:post.get(account)?.owner||pre.get(account)?.owner||null,
      eventType:null,status:"INSTRUCTION_ONLY",reason:"instruction_not_an_inventory_or_trade_fact"};
    if(INIT.has(type)) {
      common.eventType="ACCOUNT_INITIALIZE";
      const after=post.get(account);
      if(after && typeof info.owner==="string" && info.owner===after.owner
        && typeof info.mint==="string" && info.mint===after.mint) {
        common.status="POST_BALANCE_CORROBORATED";
        common.reason="parsed_initialize_matches_post_token_balance";
      }
    } else if(type==="closeAccount") {
      common.eventType="ACCOUNT_CLOSE";
      const before=pre.get(account), after=post.get(account);
      const idx=keys.indexOf(account);
      const postLamport=Array.isArray(tx.postBalances)&&idx>=0?atomic(tx.postBalances[idx]):null;
      if(before && before.amountAtomic===0n && !after && postLamport===0n){
        common.status="EFFECT_CORROBORATED";
        common.reason="parsed_close_zero_token_pre_balance_absent_post_and_zero_post_lamports";
      } else {
        common.reason="close_requires_zero_pre_token_and_confirmed_account_disappearance";
      }
      common.rentRefundNotFee=true;
    } else if(type==="syncNative") {
      common.eventType="WSOL_SYNC_NATIVE";
      if(common.mint===WSOL){
        common.status="WSOL_OPERATION_OBSERVED";
        common.reason="native_sync_on_wrapped_sol_account_not_a_swap";
      }else{
        common.reason=common.mint?"non_wsol_sync_anomaly":"wsol_mint_unknown";
        if(common.mint)result.issues.push("SYNC_NATIVE_NON_WSOL:"+account);
      }
      common.tradeClassification="NOT_A_TRADE";
    } else if(type==="setAuthority" && /accountowner/i.test(String(info.authorityType||""))) {
      common.eventType="OWNER_AUTHORITY_CHANGE";
      common.reason="authority_instruction_requires_independent_owner_transition_verification";
      common.newAuthority=typeof info.newAuthority==="string"?info.newAuthority:null;
      result.issues.push("OWNER_CHANGE_NEEDS_HISTORY_PROOF:"+account);
    } else if(FEE_OPS.has(type)) {
      if(op?.programId!==TOKEN_2022&&op?.program!=="spl-token-2022")continue;
      common.eventType="TOKEN2022_FEE_MECHANISM";
      common.reason="token2022_fee_operation_seen_but_withheld_amount_and_owner_not_verified";
      common.status="UNVALUED_EVIDENCE";
      common.tradeClassification="NOT_AUTOMATIC_TRADE_OR_FEE";
      result.issues.push("TOKEN2022_WITHHELD_FEE_NOT_RECONCILED:"+account);
    } else continue;
    result.actions.push(common);
  }
  return result;
}
module.exports={inspectLifecycle,parseTokenSides,atomic,WSOL,TOKEN_2022};
