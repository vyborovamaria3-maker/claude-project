import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTokenId, parseTokenId, validateTokenId,
  formatWalletId, parseWalletId, normalizeAddress, normalizeMint,
  isSolanaPublicKey, isSolanaSignature, formatAuthorId, parseAuthorId,
  formatSourceId, parseSourceId,
} from "../dist/index.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EVM = "0x" + "Aa".repeat(20);

test("Solana canonical identity is strict, base58-aware and case-sensitive", () => {
  assert.equal(formatTokenId("solana", SOL), "solana:" + SOL);
  assert.equal(normalizeMint("solana", USDC), USDC);
  assert.equal(parseTokenId("solana:" + SOL)?.mint, SOL);
  assert.equal(parseTokenId("solana:" + SOL)?.chain, "solana");
  assert.equal(isSolanaPublicKey("1".repeat(32)), true); // 32 leading zero bytes
  assert.equal(isSolanaPublicKey("1".repeat(31)), false);
  assert.equal(isSolanaPublicKey("1".repeat(33)), false);
  assert.notEqual(formatTokenId("solana", SOL), "solana:" + SOL.toLowerCase()); // no case folding
  assert.equal(isSolanaPublicKey("O".repeat(32)), false);
  assert.equal(isSolanaSignature("1".repeat(64)), true);
  assert.equal(isSolanaSignature("1".repeat(63)), false);
});

test("EVM addresses require exactly 20 bytes and are normalized", () => {
  for (const chain of ["ethereum", "base", "arbitrum"]) {
    const canonical = chain + ":" + EVM.toLowerCase();
    assert.equal(formatTokenId(chain, EVM), canonical);
    assert.equal(parseTokenId(chain + ":" + EVM)?.id, canonical);
    assert.equal(validateTokenId(canonical), true);
    assert.equal(validateTokenId(chain + ":" + EVM), false);
    assert.equal(formatWalletId(chain, EVM), canonical);
    assert.equal(parseWalletId(chain + ":" + EVM)?.address, EVM.toLowerCase());
  }
  assert.throws(() => normalizeAddress("ethereum", "0xAbCd"), /Invalid EVM/);
});

test("invalid, ambiguous and placeholder identifiers are rejected", () => {
  for (const value of [
    "garbage", "solana:", ":mint", "solana:5Xax...", "doge:" + SOL,
    "solana:" + SOL + ":extra", "ethereum:0x123", "SOLANA:" + SOL,
    "solana: " + SOL, "solana:" + SOL + " ",
    null, 42, {},
  ]) {
    assert.equal(parseTokenId(value), null);
    assert.equal(validateTokenId(value), false);
  }
  assert.throws(() => formatTokenId("solana", "5Xax..."), /Invalid Solana/);
});

test("stable social identities never use username, and huge IDs remain text", () => {
  const hugeXId = "9223372036854775808123456789";
  assert.equal(formatAuthorId("x", hugeXId), "x:" + hugeXId);
  assert.equal(parseAuthorId("x:" + hugeXId)?.accountId, hugeXId);
  assert.equal(formatSourceId("x", hugeXId), "x:account:" + hugeXId);
  assert.equal(parseSourceId("x:account:" + hugeXId)?.accountId, hugeXId);
  assert.equal(formatSourceId("tg", "-1001234567890"), "tg:source:-1001234567890");
  assert.equal(parseAuthorId("tg:10000")?.platform, "tg");
  assert.equal(parseSourceId("tg:source:-1001234567890")?.platform, "tg");
  for (const invalid of ["x:@alice", "x:alice", "x:001", "tg:source:@channel", "x:account:-10"]) {
    assert.equal(parseAuthorId(invalid), null);
    assert.equal(parseSourceId(invalid), null);
  }
  assert.throws(() => formatAuthorId("x", "alice"), /Stable numeric/);
});
