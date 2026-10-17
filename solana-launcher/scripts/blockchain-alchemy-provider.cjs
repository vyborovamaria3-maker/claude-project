"use strict";

// Alchemy Solana historical provider. No Helius fallback is permitted here.
// Uses the documented getTransactionsForAddress RPC extension with opaque paginationToken.
const DEFAULT_RPC = "https://solana-mainnet.g.alchemy.com/v2/";
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const DEX_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  "675kPX9MHTjS2zt1qfr1NYHuze9WQqVJ5Dq7bqW",
  "CPMMoo8L3F4NbTegBCKVNqW9pXQwY6c9K7e8w4Z",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
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

function decodeCursor(cursor) {
  if (!cursor) return null;
  if (typeof cursor !== "string" || !cursor.startsWith("alchemy:v1:")) {
    throw new Error("Incompatible history cursor; reset provider cursor and backfill from Alchemy");
  }
  return cursor.slice("alchemy:v1:".length) || null;
}
function encodeCursor(token) {
  return token ? "alchemy:v1:" + token : null;
}

function normalizeFullTransaction(item) {
  const transaction = item && item.transaction;
  const signature = item?.signature ||
    transaction?.transaction?.signatures?.[0] ||
    transaction?.signatures?.[0];
  if (typeof signature !== "string" || !signature) return null;
  const slot = Number(item.slot ?? transaction?.slot);
  const blockTime = Number(item.blockTime ?? transaction?.blockTime);
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
    transactionError: meta?.err ?? null,
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
      owner: v.owner, accountIndex: v.accountIndex, mint: v.mint, decimals: v.decimals,
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
    let token = decodeCursor(paginationToken) || undefined;
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
      const page = Array.isArray(response.result?.transactions) ? response.result.transactions :
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
          if (!normalized) continue;
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
      if (typeof nextToken === "string" && nextToken && nextToken !== token) token = nextToken;
      else { token = undefined; exhausted = true; break; }
      if (reachedKnownHistory || transactions.length >= limit) break;
    }
    return {
      transactions,
      nextCursor: token ? encodeCursor(token) : null,
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
      if (tx.transactionError != null || !tx.instructionProgramIds?.some((id) => DEX_PROGRAMS.has(id))) continue;
      const deltas = (tx.tokenBalanceDeltas || []).filter((d) => d.mint === mint && d.owner && d.deltaRaw !== "0");
      if (deltas.length !== 1) continue;
      const delta = deltas[0];
      const keyIndex = tx.accountKeys.indexOf(delta.owner);
      if (keyIndex < 0) continue;
      const nativeDeltaLamports = Number(tx.postBalances[keyIndex] ?? 0) - Number(tx.preBalances[keyIndex] ?? 0);
      const feeLamports = Number(tx.meta?.fee || 0);
      const isBuy = Number(delta.deltaRaw) > 0;
      const solLamports = isBuy ? -(nativeDeltaLamports + feeLamports) : nativeDeltaLamports + feeLamports;
      const amountTokens = Math.abs(delta.delta);
      const amountSol = solLamports / 1e9;
      if (!(amountTokens > 0 && amountSol > 0 && Number.isFinite(amountSol))) continue;
      trades.push({
        signature: tx.signature, timestamp: tx.timestamp, slot: tx.slot, trader: delta.owner,
        type: isBuy ? "buy" : "sell", amountSol, amountTokens, priceSol: amountSol / amountTokens,
        fee: feeLamports / 1e9, source: "alchemy", quoteMint: "So11111111111111111111111111111111111111112",
        quoteAmount: amountSol, quoteDecimals: 9, decoderCoverage: "swap_only"
      });
    }
    return trades;
  }

  return { rpc, fetchTransactionsForAddress, txsToTrades, provider: "alchemy" };
}

module.exports = { createAlchemyProvider, getAlchemyConfig, normalizeFullTransaction };
