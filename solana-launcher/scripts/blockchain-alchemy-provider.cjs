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
  const date=new Date(now);
  let year=date.getUTCFullYear(),month=date.getUTCMonth();
  const effectiveDay=Math.min(resetDay,new Date(Date.UTC(year,month+1,0)).getUTCDate());
  if(date.getUTCDate()<effectiveDay){month--;if(month<0){month=11;year--;}}
  const startDay=Math.min(resetDay,new Date(Date.UTC(year,month+1,0)).getUTCDate());
  if(resetDay===1)return String(year)+"-"+String(month+1).padStart(2,"0");
  return new Date(Date.UTC(year,month,startDay)).toISOString().slice(0,10);
}
function normalizeRawTransaction(entry) {
  const tx = entry && (entry.transaction || entry);
  const meta = (entry && entry.meta) || (tx && tx.meta) || null;
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
    ...(entry && typeof entry==="object" ? entry : {}),
    signature, slot:Number.isFinite(entry && entry.slot)?entry.slot:null,
    timestamp:blockTime, blockTime, transactionError:meta && meta.err != null ? meta.err : null,
    fee:Number.isFinite(meta && meta.fee)?meta.fee:null,
    sourceProvider:"alchemy", sourceDetailLevel:"raw",
    // Balance changes reveal touched owners/mints but are not proof of a transfer.
    tokenBalanceChanges,
    // Do not infer native transfers from lamport deltas: fees, rent, and swaps
    // make that inference ambiguous without instruction decoding.
    nativeTransfers:[],
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
  if (!options.fetch && !options.accounts && (env.ALCHEMY_API_KEY || env.ALCHEMY_API_KEYS || env.ALCHEMY_SOLANA_RPC_URL || env.NEXT_PUBLIC_ALCHEMY_RPC_URL || /^https:\/\/solana-mainnet\.g\.alchemy\.com\/v2\//i.test(env.QUICKNODE_RPC_URL||env.NEXT_PUBLIC_QUICKNODE_RPC_URL||''))) {
    const config=getAlchemyConfig(env);
    const accounts=config.endpoints.map((endpoint,index)=>({id:'alchemy-'+(index+1),index:index+1,monthlyBudgetCu:1000000,baselineCu:0,billingResetDay:1}));
    return {accounts,pilotBudgetCu:DEFAULT_PILOT_CU,health:()=>accounts,fetchHistoryWithMeta:async(address,limit,known,cursor,_include,hooks={})=>{
      const runtime=require('./blockchain-runtime.cjs');
      const provider=createAlchemyProvider({env,request:async(urls,body)=>{
        let httpRequests=0;
        const result=await runtime.jsonRequest(urls,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},async(url)=>{
          const accountId='alchemy-'+(config.endpoints.indexOf(url)+1);
          const reservation=await hooks.beforeRequest?.({provider:'alchemy',accountId,address,method:body.method,
            estimatedCu:getMethodCost(body.method,env),monthlyBudgetCu:1000000,baselineCu:0,billingResetDay:1});
          httpRequests++; return reservation;
        },{afterResponse:(id,response)=>hooks.afterResponse?.(id,{status:response.status,actualCu:null}),onError:(id,error)=>hooks.onError?.(id,error)});
        return {result:result.result,httpRequests};
      }});
      const page=await provider.fetchTransactionsForAddress(address,limit,known||new Set(),cursor);
      return {...page,provider:'alchemy',transactions:page.transactions.map(tx=>({...tx,...normalizeRawTransaction(tx.raw),
        sourceProvider:'alchemy',sourceDetailLevel:'raw',transactionError:tx.transactionError}))};
    }};
  }
  const fetchImpl=options.fetch || globalThis.fetch;
  const accounts=options.accounts || parseAccounts(env);
  const timeoutMs=positiveInt(env.ALCHEMY_SOLANA_TIMEOUT_MS,12000,"ALCHEMY_SOLANA_TIMEOUT_MS");
  const pilotBudgetCu=positiveInt(env.ALCHEMY_SOLANA_PILOT_CU_BUDGET,DEFAULT_PILOT_CU,"ALCHEMY_SOLANA_PILOT_CU_BUDGET");
  let nextAccount=0;
  const cooldownUntil=new Map(),failureCounts=new Map(),lastErrors=new Map();
  function markFailure(account,error,response=null) {
    const code=error&&error.code;
    if(code==="ALCHEMY_ACCOUNT_BUDGET_EXCEEDED"||code==="ALCHEMY_PILOT_CU_BUDGET_EXCEEDED"||code==="ALCHEMY_RUN_CU_BUDGET_EXCEEDED")return;
    const count=(failureCounts.get(account.id)||0)+1;
    failureCounts.set(account.id,count);
    lastErrors.set(account.id,String(error&&error.message||error).slice(0,200));
    const retryHeader=response&&response.headers&&response.headers.get&&Number(response.headers.get("retry-after"));
    const delay=Number.isFinite(retryHeader)&&retryHeader>0
      ?Math.min(120000,retryHeader*1000)
      :Math.min(60000,1000*2**Math.min(6,count-1));
    cooldownUntil.set(account.id,Date.now()+delay);
  }
  async function fetchPage(address, paginationToken, limit, hooks = {}) {
    if (!accounts.length) throw new Error("No Alchemy Solana keys configured (ALCHEMY_SOLANA_API_KEY_1..4 or ALCHEMY_SOLANA_API_KEYS)");
    const method="getTransactionsForAddress", cost=getMethodCost(method,env);
    let lastError=null;
    const startIndex=nextAccount;
    for (let offset=0;offset<accounts.length;offset++) {
      const account=accounts[(startIndex+offset)%accounts.length];
      if ((cooldownUntil.get(account.id)||0)>Date.now()) { lastError=new Error("Alchemy account "+account.id+" is in rate-limit cooldown"); continue; }
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
            maxSupportedTransactionVersion:0,commitment:"finalized",encoding:"jsonParsed",transactionDetails:"full",sortOrder:"desc",limit:Math.max(1,Math.min(100,limit)),
            ...(paginationToken?{paginationToken}:{}),
            filters:{status:"any",tokenAccounts:"balanceChanged"}
          }]})
        });
        const payload=await response.json();
        await hooks.afterResponse?.(reservationId,{status:response.status,actualCu:null,rpcError:Boolean(payload.error),provider:"alchemy",accountId:account.id});
        if (!response.ok || payload.error) {
          const err=new Error("Alchemy "+account.id+" "+(payload.error && payload.error.message || "HTTP "+response.status));
          err.status=response.status; err.code=response.status===429?"ALCHEMY_RATE_LIMIT":payload.error&&payload.error.code===-32601?"ALCHEMY_METHOD_UNSUPPORTED":"ALCHEMY_RPC_ERROR";
          if(response.status===429||response.status>=500)markFailure(account,err,response);
          throw err;
        }
        failureCounts.delete(account.id);cooldownUntil.delete(account.id);lastErrors.delete(account.id);
        const result=payload.result;
        const rows=Array.isArray(result)?result:Array.isArray(result?.data)?result.data:Array.isArray(result && result.transactions)?result.transactions:null;
        if (!rows) throw new Error("Alchemy getTransactionsForAddress returned unexpected response shape");
        nextAccount=(account.index)%accounts.length;
        return {transactions:rows.map(normalizeRawTransaction),paginationToken:result.paginationToken||null,exhausted:!result.paginationToken,provider:"alchemy",accountId:account.id};
      } catch(error) {
        await hooks.onError?.(reservationId,error);
        if (error && error.code==="ALCHEMY_CU_BUDGET_EXCEEDED") throw error;
        lastError=error instanceof Error?error:new Error(String(error));
        if (lastError.code==="ALCHEMY_METHOD_UNSUPPORTED") throw lastError;
        if(lastError.code!=="ALCHEMY_RATE_LIMIT"&&lastError.code!=="ALCHEMY_RPC_ERROR")markFailure(account,lastError);
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
    const alchemyCursor=decodeCursor(startCursor);
    const anchorSignature=startCursor && !alchemyCursor && !String(startCursor).startsWith("alchemy:") ? startCursor : null;
    let anchorReached=!anchorSignature;
    let paginationToken=alchemyCursor||undefined;
    let transactions=[],exhausted=false,reachedKnownHistory=false,budgetExhausted=false;
    const seen=new Set(),seenCursors=new Set();
    while(transactions.length<maxTxs) {
      let page;
      try {
        page=await fetchPage(address,paginationToken,Math.min(100,maxTxs-transactions.length),hooks);
      } catch(error) {
        if(!error || !["ALCHEMY_PILOT_CU_BUDGET_EXCEEDED","ALCHEMY_RUN_CU_BUDGET_EXCEEDED","ALCHEMY_ALL_ACCOUNTS_BUDGET_EXCEEDED"].includes(error.code) || !transactions.length) throw error;
        budgetExhausted=true;
        break;
      }
      if(!page.transactions.length) {
        if(page.paginationToken && !seenCursors.has(page.paginationToken)) {
          seenCursors.add(page.paginationToken);paginationToken=page.paginationToken;continue;
        }
        exhausted=true;
        if(!anchorReached) {
          const error=new Error("Alchemy could not locate saved signature cursor in address history; coverage remains partial");
          error.code="ALCHEMY_CURSOR_ANCHOR_NOT_FOUND";
          throw error;
        }
        break;
      }
      let rows=page.transactions;
      if(!anchorReached) {
        const anchorIndex=rows.findIndex(tx=>tx && tx.signature===anchorSignature);
        if(anchorIndex<0) {
          if(!page.paginationToken) {
            const error=new Error("Alchemy could not locate saved signature cursor in address history; coverage remains partial");
            error.code="ALCHEMY_CURSOR_ANCHOR_NOT_FOUND";
            throw error;
          }
          if(seenCursors.has(page.paginationToken)) throw new Error("Alchemy pagination stalled before saved signature cursor");
          seenCursors.add(page.paginationToken);paginationToken=page.paginationToken;continue;
        }
        anchorReached=true;
        rows=rows.slice(anchorIndex+1);
      }
      for(const tx of rows) {
        if(!tx || !tx.signature || seen.has(tx.signature)) continue;
        seen.add(tx.signature);
        transactions.push(tx);
        if(stopAtSignatures && stopAtSignatures.has(tx.signature)) { reachedKnownHistory=true; break; }
        if(transactions.length>=maxTxs) break;
      }
      paginationToken=page.paginationToken||undefined;
      if(reachedKnownHistory) { exhausted=!paginationToken; break; }
      if(!paginationToken) { exhausted=true; break; }
      if(seenCursors.has(paginationToken)) throw new Error("Alchemy pagination stalled: token repeated");
      seenCursors.add(paginationToken);
      if(transactions.length>=maxTxs) break;
    }
    return {transactions,exhausted,reachedKnownHistory,truncated:!exhausted&&!reachedKnownHistory&&transactions.length>=maxTxs,
      budgetExhausted,nextCursor:!exhausted?encodeCursor(paginationToken):null,provider:"alchemy"};
  }
  return {accounts:accounts.map(({key,...safe})=>safe),pilotBudgetCu,fetchPage,fetchHistoryWithMeta,encodeCursor,decodeCursor,
    health:()=>accounts.map(({key,...account})=>({...account,cooldownUntil:cooldownUntil.get(account.id)||0,
      failures:failureCounts.get(account.id)||0,lastError:lastErrors.get(account.id)||null}))};
}


// Alchemy Solana historical provider. No Helius fallback is permitted here.
// Uses the documented getTransactionsForAddress RPC extension with opaque paginationToken.
const DEFAULT_RPC = "https://solana-mainnet.g.alchemy.com/v2/";
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const DEX_PROGRAMS = new Set([
  // Canonical program IDs used for conservative candidate detection only.
  // This is not a complete Solana DEX registry and cannot authorize PnL.
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // Pump.fun
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"  // PumpSwap
]);

function getAlchemyConfig(env = process.env) {
  const legacyRpcUrl = env.NEXT_PUBLIC_QUICKNODE_RPC_URL || env.QUICKNODE_RPC_URL;
  // Some existing deployments stored an Alchemy URL under the old QuickNode
  // variable name. Accept it only when its host is verifiably Alchemy.
  const legacyAlchemyUrl = typeof legacyRpcUrl === "string"
    && /^https:\/\/solana-mainnet\.g\.alchemy\.com\/v2\//i.test(legacyRpcUrl)
    ? legacyRpcUrl : "";
  const explicitUrl = env.ALCHEMY_SOLANA_RPC_URL || env.NEXT_PUBLIC_ALCHEMY_RPC_URL || legacyAlchemyUrl;
  const keys = String(env.ALCHEMY_API_KEYS || "")
    .split(/[;,\s]+/).map((v) => v.trim()).filter(Boolean);
  if (env.ALCHEMY_API_KEY && !keys.includes(env.ALCHEMY_API_KEY.trim())) keys.unshift(env.ALCHEMY_API_KEY.trim());
  const endpoints = explicitUrl
    ? [explicitUrl]
    : keys.map((key) => DEFAULT_RPC + encodeURIComponent(key));
  if (endpoints.some((endpoint) => !/^https:\/\/solana-mainnet\.g\.alchemy\.com\/v2\//i.test(endpoint))) {
    throw new Error("ALCHEMY_SOLANA_RPC_URL must be an Alchemy Solana mainnet RPC URL");
  }
  if (!endpoints.length) throw new Error("Alchemy Solana API key or ALCHEMY_SOLANA_RPC_URL required; Helius is not a fallback");
  return { endpoint: endpoints[0], endpoints, keyCount: endpoints.length };
}

function decodeCanonicalCursor(cursor) {
  if (!cursor) return null;
  if (typeof cursor !== "string" || !cursor.startsWith("alchemy:v1:")) {
    throw new Error("Incompatible history cursor; reset provider cursor and backfill from Alchemy");
  }
  return cursor.slice("alchemy:v1:".length) || null;
}
function encodeCanonicalCursor(token) {
  return token ? "alchemy:v1:" + token : null;
}

function normalizeFullTransaction(item) {
  const transaction = item && item.transaction;
  const signature = item?.signature ||
    transaction?.transaction?.signatures?.[0] ||
    transaction?.signatures?.[0];
  if (typeof signature !== "string" || !signature) return null;
  const slotValue = item.slot ?? transaction?.slot;
  const timeValue = item.blockTime ?? transaction?.blockTime;
  const slot = slotValue == null ? NaN : Number(slotValue);
  const blockTime = timeValue == null ? NaN : Number(timeValue);
  const meta = item.meta || transaction?.meta || null;
  const txObject = transaction?.transaction ? transaction.transaction : transaction;
  const message = txObject?.message || {};
  const accountKeys = (message.accountKeys || []).map((key) =>
    typeof key === "string" ? key : (key?.pubkey || key?.toString?.() || ""));
  const preBalances = meta?.preBalances || [];
  const postBalances = meta?.postBalances || [];
  const preTokenBalances = meta?.preTokenBalances || [];
  const postTokenBalances = meta?.postTokenBalances || [];
  const instructionProgramIds = [];
  const decodedOperations = [];
  const collectInstruction = (ix) => {
    const id = ix.programId || (Number.isInteger(ix.programIdIndex) ? accountKeys[ix.programIdIndex] : null);
    if (id) instructionProgramIds.push(String(id));
    const parsedType = ix.parsed?.type;
    if (typeof parsedType === "string") {
      decodedOperations.push({
        program: String(ix.program || id || "unknown"),
        programId: id ? String(id) : null,
        type: parsedType,
        info: ix.parsed?.info && typeof ix.parsed.info === "object" ? ix.parsed.info : {},
        decoderCoverage: ["transfer", "transferChecked", "mintTo", "mintToChecked", "burn", "burnChecked"].includes(parsedType)
          ? "swap_and_transfers_mint_burn" : "partial",
      });
    }
  };
  for (const ix of message.instructions || []) {
    collectInstruction(ix);
  }
  for (const ix of meta?.innerInstructions || []) {
    for (const inner of ix.instructions || []) collectInstruction(inner);
  }
  const tokens = new Map();
  const tokenBalanceKey = (entry) => {
    const owner = entry.owner || "";
    const mint = entry.mint || "";
    // If owner metadata is missing, retain token-account identity. Aggregating
    // all ownerless accounts for the same mint can manufacture false deltas.
    const account = entry.accountIndex == null ? "unknown-account" : String(entry.accountIndex);
    return { owner, mint, key: (owner || "account:" + account) + "|" + mint };
  };
  for (const entry of preTokenBalances) {
    const { owner, mint, key } = tokenBalanceKey(entry);
    const amount = BigInt(entry.uiTokenAmount?.amount || "0");
    const prior = tokens.get(key) || {
      owner, mint, accountIndex: entry.accountIndex ?? null,
      tokenAccount: Number.isInteger(entry.accountIndex) ? accountKeys[entry.accountIndex] || null : null,
      decimals: Number(entry.uiTokenAmount?.decimals || 0), pre: 0n, post: 0n
    };
    prior.pre += amount;
    tokens.set(key, prior);
  }
  for (const entry of postTokenBalances) {
    const { owner, mint, key } = tokenBalanceKey(entry);
    const amount = BigInt(entry.uiTokenAmount?.amount || "0");
    const prior = tokens.get(key) || {
      owner, mint, accountIndex: entry.accountIndex ?? null,
      tokenAccount: Number.isInteger(entry.accountIndex) ? accountKeys[entry.accountIndex] || null : null,
      decimals: Number(entry.uiTokenAmount?.decimals || 0), pre: 0n, post: 0n
    };
    prior.post += amount;
    prior.decimals = Number(entry.uiTokenAmount?.decimals ?? prior.decimals);
    tokens.set(key, prior);
  }
  return {
    signature,
    timestamp: Number.isFinite(blockTime) ? blockTime : null,
    slot: Number.isFinite(slot) ? slot : null,
    transactionError: meta && Object.hasOwn(meta, "err") ? meta.err : { unknown: "missing_execution_status" },
    fee: Number.isFinite(Number(meta?.fee)) ? Number(meta.fee) / 1e9 : null,
    source: "alchemy",
    provider: "alchemy",
    raw: item,
    accountKeys,
    preBalances,
    postBalances,
    preTokenBalances,
    postTokenBalances,
    instructionProgramIds: [...new Set(instructionProgramIds)],
    decodedOperations,
    tokenBalanceDeltas: [...tokens.values()].map((v) => ({
      owner: v.owner, accountIndex: v.accountIndex, tokenAccount: v.tokenAccount || null, mint: v.mint, decimals: v.decimals,
      ownerKnown: Boolean(v.owner),
      deltaRaw: (v.post - v.pre).toString(),
      delta: Number(v.post - v.pre) / (10 ** v.decimals)
    })),
    meta,
  };
}

function createAlchemyProvider(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || globalThis.fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const config = options.endpoint ? { endpoint: options.endpoint, endpoints: [options.endpoint] } : getAlchemyConfig(env);
  let requestId = 0;
  let endpointIndex = 0;
  async function rpc(method, params) {
    if (options.request) {
      return options.request(config.endpoints, { jsonrpc: '2.0', id: ++requestId, method, params });
    }
    let lastError;
    let attempts = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      attempts++;
      try {
        const response = await fetchImpl(config.endpoints[endpointIndex] || config.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
          signal: AbortSignal.timeout(Number(env.ALCHEMY_TIMEOUT_MS) || 30000),
        });
        if (!response.ok) {
          const error = new Error("Alchemy HTTP " + response.status);
          if (!RETRYABLE.has(response.status) || attempt === 4) {
            error.httpRequests = attempts;
            throw error;
          }
          lastError = error;
          endpointIndex = (endpointIndex + 1) % config.endpoints.length;
          await sleep(Math.min(8000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 150));
          continue;
        }
        const body = await response.json();
        if (body?.error) {
          const error = new Error("Alchemy RPC " + String(body.error.code) + ": " + String(body.error.message || "request failed").slice(0, 180));
          if (attempt < 4 && /rate|limit|temporar|busy/i.test(error.message)) {
            lastError = error;
            endpointIndex = (endpointIndex + 1) % config.endpoints.length;
            await sleep(Math.min(8000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 150));
            continue;
          }
          error.httpRequests = attempts;
          throw error;
        }
        return { result: body.result, httpRequests: attempts };
      } catch (error) {
        lastError = error;
        if (error?.httpRequests) throw error;
        if (attempt === 4) {
          error.httpRequests = attempts;
          throw error;
        }
        await sleep(Math.min(8000, 250 * (2 ** attempt)) + Math.floor(Math.random() * 150));
      }
    }
    lastError = lastError || new Error("Alchemy request failed");
    lastError.httpRequests = attempts;
    throw lastError;
  }

  async function fetchTransactionsForAddress(address, maxTransactions = 100, knownSignatures = new Set(), paginationToken = null) {
    const limit = Math.min(100, Math.max(1, Number(maxTransactions) || 100));
    const transactions = [];
    let token = decodeCanonicalCursor(paginationToken) || undefined;
    let httpRequests = 0;
    let pagesFetched = 0;
    let reachedKnownHistory = false;
    let exhausted = false;
    let lastPageEmpty = false;
    let safetyPages = 0;
    while (transactions.length < limit && safetyPages < 100) {
      safetyPages++;
      const remaining = limit - transactions.length;
      const pageLimit = Math.min(100, remaining);
      const params = [address, {
        transactionDetails: "full",
        sortOrder: "desc",
        limit: pageLimit,
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
        ...(token ? { paginationToken: token } : {})
      }];
      let response;
      try {
        response = await rpc("getTransactionsForAddress", params);
      } catch (error) {
        error.httpRequests = httpRequests + (Number(error.httpRequests) || 1);
        error.pagesFetched = pagesFetched;
        error.lastPageEmpty = lastPageEmpty;
        throw error;
      }
      httpRequests += response.httpRequests;
      pagesFetched++;
      const page = Array.isArray(response.result?.data) ? response.result.data :
        Array.isArray(response.result?.transactions) ? response.result.transactions :
        Array.isArray(response.result?.items) ? response.result.items :
        Array.isArray(response.result) ? response.result : null;
      if (!page) {
        const error = new Error("Unexpected Alchemy getTransactionsForAddress response shape");
        Object.assign(error, { httpRequests, pagesFetched, lastPageEmpty: false });
        throw error;
      }
      lastPageEmpty = page.length === 0;
      if (lastPageEmpty) { exhausted = true; token = undefined; break; }
      try {
        for (const item of page) {
          const normalized = normalizeFullTransaction(item);
          if (!normalized) throw new Error("Alchemy full transaction missing signature; refusing to advance cursor");
          if (knownSignatures?.has(normalized.signature)) {
            reachedKnownHistory = true;
            continue;
          }
          if (transactions.length < limit) transactions.push(normalized);
        }
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        Object.assign(error, { httpRequests, pagesFetched, lastPageEmpty });
        throw error;
      }
      const nextToken = response.result?.paginationToken ?? response.result?.pagination_token ?? null;
      if (typeof nextToken === "string" && nextToken && nextToken === token) {
        const error = new Error("Alchemy pagination cursor did not advance");
        Object.assign(error, { httpRequests, pagesFetched, lastPageEmpty });
        throw error;
      }
      if (typeof nextToken === "string" && nextToken) token = nextToken;
      else { token = undefined; exhausted = true; break; }
      if (reachedKnownHistory || transactions.length >= limit) break;
    }
    return {
      transactions,
      nextCursor: token ? encodeCanonicalCursor(token) : null,
      exhausted,
      truncated: !exhausted && !reachedKnownHistory && transactions.length >= limit,
      reachedKnownHistory,
      httpRequests,
      pagesFetched,
      lastPageEmpty,
      decoderCoverage: "swap_only",
      source: "alchemy",
    };
  }

  function txsToTrades(transactions, mint) {
    const trades = [];
    for (const tx of transactions || []) {
      if (tx.transactionError !== null || !tx.instructionProgramIds?.some((id) => DEX_PROGRAMS.has(id))) continue;
      const deltas = (tx.tokenBalanceDeltas || []).filter((d) => d.mint === mint && d.owner && d.deltaRaw !== "0");
      if (deltas.length !== 1) continue;
      const delta = deltas[0];
      const keyIndex = tx.accountKeys.indexOf(delta.owner);
      if (keyIndex < 0) continue;
      const nativeDeltaLamports = Number(tx.postBalances[keyIndex] ?? 0) - Number(tx.preBalances[keyIndex] ?? 0);
      const feeLamports = Number(tx.meta?.fee || 0);
      const isBuy = Number(delta.deltaRaw) > 0;
      const ownerFeeLamports = keyIndex === 0 ? feeLamports : 0;
      const solLamports = isBuy ? -(nativeDeltaLamports + ownerFeeLamports) : nativeDeltaLamports + ownerFeeLamports;
      const amountTokens = Math.abs(delta.delta);
      const amountSol = solLamports / 1e9;
      if (!(amountTokens > 0 && amountSol > 0 && Number.isFinite(amountSol))) continue;
      trades.push({
        signature: tx.signature, timestamp: tx.timestamp, slot: tx.slot, trader: delta.owner,
        type: isBuy ? "buy" : "sell", amountSol, amountTokens, priceSol: amountSol / amountTokens,
        fee: feeLamports / 1e9, feeLamports, source: "alchemy", quoteMint: "So11111111111111111111111111111111111111112",
        quoteAmount: amountSol, quoteDecimals: 9, decoderCoverage: "swap_only"
      });
    }
    return trades;
  }

  return { rpc, fetchTransactionsForAddress, txsToTrades, provider: "alchemy" };
}


module.exports={DEFAULT_MONTHLY_CU,DEFAULT_PILOT_CU,METHOD_COSTS,parseAccounts,getMethodCost,currentBillingMonthKey,normalizeRawTransaction,encodeCursor,decodeCursor,createProvider,createAlchemyProvider,getAlchemyConfig,normalizeFullTransaction};
