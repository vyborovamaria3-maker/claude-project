"use strict";

// Alchemy Solana address-history fallback. It returns raw transaction evidence,
// not Helius-enriched swap events; callers must not treat this as equivalent
// swap decoding or verified PnL evidence.
const DEFAULT_MONTHLY_CU = 30000000;
const DEFAULT_PILOT_CU = 3000000;
const METHOD_COSTS = Object.freeze({
  getTransactionsForAddress: 100,
  getTransaction: 40,
  getSignaturesForAddress: 40,
  getBlock: 40,
});

function positiveInt(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(name + " must be a positive integer");
  return parsed;
}
function parseAccounts(env = process.env) {
  const accounts = [];
  const shared = (env.ALCHEMY_SOLANA_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean);
  for (let i=1;i<=4;i++) {
    const key = (env["ALCHEMY_SOLANA_API_KEY_"+i] || shared[i-1] || "").trim();
    if (!key) continue;
    const budget = positiveInt(env["ALCHEMY_SOLANA_MONTHLY_CU_BUDGET_"+i], DEFAULT_MONTHLY_CU, "ALCHEMY_SOLANA_MONTHLY_CU_BUDGET_"+i);
    const baselineRaw = env["ALCHEMY_SOLANA_CU_USED_BASELINE_"+i];
    const resetRaw = env["ALCHEMY_SOLANA_BILLING_RESET_DAY_"+i];
    const baseline = baselineRaw == null || baselineRaw.trim()==="" ? null : Number(baselineRaw);
    const resetDay = resetRaw == null || resetRaw.trim()==="" ? null : Number(resetRaw);
    if (baseline !== null && (!Number.isSafeInteger(baseline) || baseline < 0)) throw new Error("ALCHEMY_SOLANA_CU_USED_BASELINE_"+i+" must be a non-negative integer");
    if (resetDay !== null && (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31)) throw new Error("ALCHEMY_SOLANA_BILLING_RESET_DAY_"+i+" must be an integer from 1 to 31");
    accounts.push({id:"alchemy-"+i,index:i,key,monthlyBudgetCu:budget,baselineCu:baseline,billingResetDay:resetDay});
  }
  return accounts;
}
function getMethodCost(method, env = process.env) {
  const configured = env["ALCHEMY_SOLANA_CU_COST_"+method];
  return positiveInt(configured, METHOD_COSTS[method], "ALCHEMY_SOLANA_CU_COST_"+method);
}
function currentBillingMonthKey(now = Date.now(), resetDay = 1) {
  const date = new Date(now);
  let year = date.getUTCFullYear(), month = date.getUTCMonth();
  if (date.getUTCDate() < resetDay) month--;
  if (month < 0) { month = 11; year--; }
  return year + "-" + String(month + 1).padStart(2,"0") + "-" + String(resetDay).padStart(2,"0");
}
function normalizeRawTransaction(entry) {
  const tx = entry && (entry.transaction || entry);
  const meta = entry && entry.meta || tx.meta || null;
  const signatures = tx && tx.transaction && tx.transaction.signatures || tx && tx.signatures || [];
  const signature = entry && entry.signature || signatures[0];
  if (typeof signature !== "string" || !signature) throw new Error("Alchemy transaction missing signature");
  const message = tx && tx.transaction && tx.transaction.message || tx && tx.message || {};
  const keys = message.accountKeys || [];
  const keyAt = index => {
    const value = keys[index];
    return typeof value === "string" ? value : value && (value.pubkey || value.toString && value.toString()) || null;
  };
  const tokenBalances = balances => Array.isArray(balances) ? balances : [];
  const balances = rows => tokenBalances(rows).map(x => ({
    accountIndex:Number(x.accountIndex),mint:x.mint,owner:x.owner||null,
    amount:String(x.uiTokenAmount && x.uiTokenAmount.amount || "0"),
    decimals:Number(x.uiTokenAmount && x.uiTokenAmount.decimals || 0),
  }));
  const before = new Map(balances(meta && meta.preTokenBalances).map(x => [String(x.accountIndex)+":"+x.mint,x]));
  const after = new Map(balances(meta && meta.postTokenBalances).map(x => [String(x.accountIndex)+":"+x.mint,x]));
  const tokenBalanceChanges = [];
  for (const tokenKey of new Set([...before.keys(),...after.keys()])) {
    const a=before.get(tokenKey), b=after.get(tokenKey);
    const rawBefore=BigInt(a?a.amount:"0"), rawAfter=BigInt(b?b.amount:"0");
    const delta=rawAfter-rawBefore;
    if (delta===0n) continue;
    const source=b||a;
    if (!source || !source.owner || !source.mint) continue;
    tokenBalanceChanges.push({mint:source.mint,owner:source.owner,accountIndex:source.accountIndex,
      decimals:source.decimals,rawAmountDelta:delta.toString()});
  }
  const blockTime = Number.isFinite(entry && entry.blockTime) ? entry.blockTime : null;
  return {
    signature, slot:Number.isFinite(entry && entry.slot)?entry.slot:null,
    timestamp:blockTime, blockTime, transactionError:meta && meta.err != null ? meta.err : null,
    fee:Number.isFinite(meta && meta.fee)?meta.fee:null,
    sourceProvider:"alchemy", sourceDetailLevel:"raw",
    // Balance changes reveal touched owners/mints but are not proof of a transfer.
    tokenBalanceChanges,
    // Do not infer native transfers from lamport deltas: fees, rent, and swaps
    // make that inference ambiguous without instruction decoding.
    nativeTransfers:[],
    rawTransaction:entry,
  };
}
function encodeCursor(token) {
  return token ? "alchemy:" + Buffer.from(token,"utf8").toString("base64url") : null;
}
function decodeCursor(cursor) {
  if (!cursor || !cursor.startsWith("alchemy:")) return null;
  try { return Buffer.from(cursor.slice("alchemy:".length),"base64url").toString("utf8"); }
  catch { throw new Error("Invalid Alchemy pagination cursor"); }
}
function createProvider(options = {}) {
  const env=options.env || process.env;
  const fetchImpl=options.fetch || globalThis.fetch;
  const accounts=options.accounts || parseAccounts(env);
  const timeoutMs=positiveInt(env.ALCHEMY_SOLANA_TIMEOUT_MS,12000,"ALCHEMY_SOLANA_TIMEOUT_MS");
  const pilotBudgetCu=positiveInt(env.ALCHEMY_SOLANA_PILOT_CU_BUDGET,DEFAULT_PILOT_CU,"ALCHEMY_SOLANA_PILOT_CU_BUDGET");
  let nextAccount=0;
  async function fetchPage(address, paginationToken, limit, hooks = {}) {
    if (!accounts.length) throw new Error("No Alchemy Solana keys configured (ALCHEMY_SOLANA_API_KEY_1..4 or ALCHEMY_SOLANA_API_KEYS)");
    const method="getTransactionsForAddress", cost=getMethodCost(method,env);
    let lastError=null;
    for (let offset=0;offset<accounts.length;offset++) {
      const account=accounts[(nextAccount+offset)%accounts.length];
      if (account.baselineCu===null || account.billingResetDay===null) {
        lastError=new Error("Alchemy account "+account.id+" needs ALCHEMY_SOLANA_CU_USED_BASELINE_"+account.index+" and ALCHEMY_SOLANA_BILLING_RESET_DAY_"+account.index+" from Dashboard before collection");
        continue;
      }
      let reservationId;
      try {
        reservationId=await hooks.beforeRequest?.({provider:"alchemy",accountId:account.id,address,method,estimatedCu:cost,monthlyBudgetCu:account.monthlyBudgetCu,baselineCu:account.baselineCu,billingResetDay:account.billingResetDay});
      } catch(error) {
        if (error && error.code==="ALCHEMY_ACCOUNT_BUDGET_EXCEEDED") { lastError=error; continue; }
        throw error;
      }
      try {
        const response=await fetchImpl("https://solana-mainnet.g.alchemy.com/v2/"+encodeURIComponent(account.key),{
          method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
          signal:AbortSignal.timeout(timeoutMs),
          body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:[address,{
            transactionDetails:"full",sortOrder:"desc",limit:Math.max(1,Math.min(100,limit)),
            ...(paginationToken?{paginationToken}:{}),
            filters:{status:"any",tokenAccounts:"balanceChanged"}
          }]})
        });
        const payload=await response.json();
        await hooks.afterResponse?.(reservationId,{status:response.status,actualCu:null,rpcError:Boolean(payload.error),provider:"alchemy",accountId:account.id});
        if (!response.ok || payload.error) {
          const err=new Error("Alchemy "+account.id+" "+(payload.error && payload.error.message || "HTTP "+response.status));
          err.status=response.status; err.code=response.status===429?"ALCHEMY_RATE_LIMIT":payload.error&&payload.error.code===-32601?"ALCHEMY_METHOD_UNSUPPORTED":"ALCHEMY_RPC_ERROR";
          throw err;
        }
        const result=payload.result;
        const rows=Array.isArray(result)?result:Array.isArray(result && result.transactions)?result.transactions:null;
        if (!rows) throw new Error("Alchemy getTransactionsForAddress returned unexpected response shape");
        nextAccount=(account.index)%accounts.length;
        return {transactions:rows.map(normalizeRawTransaction),paginationToken:result.paginationToken||null,exhausted:!result.paginationToken,provider:"alchemy",accountId:account.id};
      } catch(error) {
        await hooks.onError?.(reservationId,error);
        if (error && error.code==="ALCHEMY_CU_BUDGET_EXCEEDED") throw error;
        lastError=error instanceof Error?error:new Error(String(error));
        if (lastError.code==="ALCHEMY_METHOD_UNSUPPORTED") throw lastError;
        nextAccount=(account.index)%accounts.length;
      }
    }
    if(lastError && lastError.code==="ALCHEMY_ACCOUNT_BUDGET_EXCEEDED") {
      const error=new Error("All configured Alchemy accounts reached their monthly CU budget");
      error.code="ALCHEMY_ALL_ACCOUNTS_BUDGET_EXCEEDED";
      throw error;
    }
    throw lastError || new Error("All Alchemy Solana accounts failed");
  }
  async function fetchHistoryWithMeta(address,maxTxs,stopAtSignatures=null,startCursor=undefined,includeTokenAccounts=false,hooks={}) {
    if (!Number.isInteger(maxTxs)||maxTxs<1) throw new Error("maxTxs must be a positive integer");
    let paginationToken=decodeCursor(startCursor)||undefined;
    let transactions=[],exhausted=false,reachedKnownHistory=false;
    const seen=new Set(),seenCursors=new Set();
    while(transactions.length<maxTxs) {
      const page=await fetchPage(address,paginationToken,Math.min(100,maxTxs-transactions.length),hooks);
      if(!page.transactions.length) { exhausted=true; break; }
      for(const tx of page.transactions) {
        if(!tx || !tx.signature || seen.has(tx.signature)) continue;
        seen.add(tx.signature);
        if(stopAtSignatures && stopAtSignatures.has(tx.signature)) { transactions.push(tx); reachedKnownHistory=true; break; }
        transactions.push(tx);
        if(transactions.length>=maxTxs) break;
      }
      if(reachedKnownHistory) {
        paginationToken=page.paginationToken||undefined;
        exhausted=!paginationToken;
        break;
      }
      if(!page.paginationToken) { exhausted=true; break; }
      if(seenCursors.has(page.paginationToken)) throw new Error("Alchemy pagination stalled: token repeated");
      seenCursors.add(page.paginationToken);
      paginationToken=page.paginationToken;
      if(transactions.length>=maxTxs) break;
    }
    return {transactions,exhausted,reachedKnownHistory,truncated:!exhausted&&!reachedKnownHistory&&transactions.length>=maxTxs,
      budgetExhausted:false,nextCursor:!exhausted?encodeCursor(paginationToken):null,provider:"alchemy"};
  }
  return {accounts:accounts.map(({key,...safe})=>safe),pilotBudgetCu,fetchPage,fetchHistoryWithMeta,encodeCursor,decodeCursor};
}
module.exports={DEFAULT_MONTHLY_CU,DEFAULT_PILOT_CU,METHOD_COSTS,parseAccounts,getMethodCost,currentBillingMonthKey,normalizeRawTransaction,encodeCursor,decodeCursor,createProvider};
