import assert from "node:assert/strict";
import { test } from "node:test";
import { matchKnownTokenAddresses } from "../src/intelligence/tweet-token-linker";

test("token linker confirms only exact addresses present in the known mint registry", () => {
  const knownMint = "So11111111111111111111111111111111111111112";
  const unregisteredMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const matches = matchKnownTokenAddresses("watch " + knownMint + " and " + unregisteredMint, new Set([knownMint]));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].mint, knownMint);
  assert.equal(matches[0].matchMethod, "mint_literal");
  assert.equal(matches[0].matchLevel, "exact");
  assert.equal(matches[0].confidence, 1);
  assert.equal(matches[0].evidence.position, "watch ".length);
});

test("token linker does not promote arbitrary valid addresses without registry evidence", () => {
  const mint = "So11111111111111111111111111111111111111112";
  assert.deepEqual(matchKnownTokenAddresses("address " + mint, new Set()), []);
  assert.deepEqual(matchKnownTokenAddresses("address " + mint, new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"])), []);
  assert.deepEqual(matchKnownTokenAddresses(null, new Set([mint])), []);
});