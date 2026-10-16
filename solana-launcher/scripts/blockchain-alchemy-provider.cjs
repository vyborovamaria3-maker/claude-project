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
  const before = new Map(tokenBalances(meta && meta.preTokenBalances).map(x => [String(x.accountIndex)+":"+x.mint,{owner:x.owner||null,amount:Number(x.uiTokenAmount && x.uiTokenAmount.uiAmountString ?? x.uiTokenAmount && x.uiTokenAmount.uiAmount ?? 0),decimals:Number(x.uiTokenAmount && x.uiTokenAmount.decimals||0)}]));
  const after = new Map(tokenBalances(meta && meta.postTokenBalances).map(x => [String(x.accountIndex)+":"+x.mint,{owner:x.owner||null,amount:Number(x.uiTokenAmount && x.uiTokenAmount.uiAmountString ?? x.uiTokenAmount && x.uiTokenAmount.uiAmount ?? 0),decimals:Number(x.uiTokenAmount && x.uiTokenAmount.decimals||0)}]));
  const keysSet = new Set([...before.keys(),...after.keys()]);
  const changes = new Map();
  for (const tokenKey of keysSet) {
    const a = before.get(tokenKey), b = after.get(tokenKey);
    const mint = tokenKey.slice(tokenKey.indexOf(":")+1);
    const delta = (b ? b.amount : 0) - (a ? a.amount : 0);
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-12) continue;
    const owner = (b && b.owner) || (a && a.owner) || null;
    if (!owner) continue;
    if (!changes.has(mint)) changes.set(mint,[]);
    changes.get(mint).push({owner,delta,accountIndex:Number(tokenKey.slice(0,tokenKey.indexOf(":")))});
  }
  const tokenTransfers = [];
  for (const [mint, legs] of changes) {
    const debits=legs.filter(x=>x.delta<0), credits=legs.filter(x=>x.delta>0);
    if (debits.length===1 && credits.length===1 && debits[0].owner!==credits[0].owner) {
      tokenTransfers.push({mint,tokenAmount:Math.min(Math.abs(debits[0].delta),credits[0].delta),fromUserAccount:debits[0].owner,toUserAccount:credits[0].owner,source:"alchemy-token-balance-delta"});
    }
  }
  const blockTime = Number.isFinite(entry && entry.blockTime) ? entry.blockTime : null;
  return {
    signature, slot:Number.isFinite(entry && entry.slot)?entry.slot:null,
    timestamp:blockTime, blockTime, transactionError:meta && meta.err != null ? meta.err : null,
    fee:Number.isFinite(meta && meta.fee)?meta.fee:null,
    sourceProvider:"alchemy", sourceDetailLevel:"raw",
    tokenTransfers,
    // Do not infer native transfers from lamport deltas: fees, rent, and swaps
    // make that inference ambiguous without instruction decoding.
    nativeTransfers:[],
    rawTransaction:entry,
  };
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
        throw new Error("Alchemy account "+account.id+" needs ALCHEMY_SOLANA_CU_USED_BASELINE_"+account.index+" and ALCHEMY_SOLANA_BILLING_RESET_DAY_"+account.index+" from Dashboard before collection");
      }
      const reservationId=await hooks.beforeRequest?.({provider:"alchemy",accountId:account.id,address,method,estimatedCu:cost,monthlyBudgetCu:account.monthlyBudgetCu,baselineCu:account.baselineCu,billingResetDay:account.billingResetDay});
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
        await hooks.afterResponse?.(reservationId,{status:response.status,actualCu:null,provider:"alchemy",accountId:account.id});
        const payload=await response.json();
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
    throw lastError || new Error("All Alchemy Solana accounts failed");
  }
  return {accounts:accounts.map(({key,...safe})=>safe),pilotBudgetCu,fetchPage};
}
module.exports={DEFAULT_MONTHLY_CU,DEFAULT_PILOT_CU,METHOD_COSTS,parseAccounts,getMethodCost,currentBillingMonthKey,normalizeRawTransaction,createProvider};
