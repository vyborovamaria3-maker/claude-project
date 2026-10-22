import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTokenIdFromNative, formatTokenId, parseTokenId,
} from "../dist/index.js";

const mint = "So11111111111111111111111111111111111111112";
const secondMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("TG tuple, X mint and chain swap mint resolve to one shared token ID", () => {
  // Native stores are independent; only known/verified evidence is eligible
  // for a token-link event. Identity normalization is not that verification.
  const tg = canonicalTokenIdFromNative("solana-mainnet", mint);
  const x = canonicalTokenIdFromNative("solana", mint);
  const chain = formatTokenId("solana", mint);
  assert.equal(tg, chain);
  assert.equal(x, chain);
  assert.deepEqual(parseTokenId(tg), {chain:"solana",address:mint,mint,id:tg});
});

test("different mints, ambiguous tickers and mismatched chains never join", () => {
  assert.notEqual(canonicalTokenIdFromNative("solana-mainnet",mint),
    canonicalTokenIdFromNative("solana-mainnet",secondMint));
  for (const raw of ["$SOL","SOL","So1111...",mint.toLowerCase(),"",null,undefined]) {
    assert.throws(() => canonicalTokenIdFromNative("solana-mainnet",raw));
  }
  for (const chain of ["solana-devnet","solana-testnet","polygon","Solana",""]) {
    assert.throws(() => canonicalTokenIdFromNative(chain,mint), /Unsupported/);
  }
  const evm="0x"+"Aa".repeat(20);
  assert.equal(canonicalTokenIdFromNative("base",evm),"base:"+evm.toLowerCase());
  assert.notEqual(canonicalTokenIdFromNative("base",evm),
    canonicalTokenIdFromNative("ethereum",evm));
});

test("address syntax does not assert mint verification or token ownership", () => {
  const candidate = canonicalTokenIdFromNative("solana-mainnet", "1".repeat(32));
  assert.equal(candidate, "solana:"+"1".repeat(32));
  assert.ok(candidate.startsWith("solana:"));
  // A candidate still requires independent SPL mint account validation.
});
