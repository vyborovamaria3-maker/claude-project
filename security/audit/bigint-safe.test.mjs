import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const implementations = [
  require('../../solana-launcher/scripts/bigint-safe-package/index.cjs'),
  require('../../solana-subscription-service/packages/bigint-safe/index.cjs'),
];
for (const [index, api] of implementations.entries()) {
  test(`unsigned Solana layouts and safe bounds (${index})`, () => {
    for (const width of [1, 2, 4, 8, 16, 32]) {
      const max = (1n << BigInt(width * 8)) - 1n;
      for (const value of [0n, 1n, max - 1n, max]) {
        const bytes = api.toBufferBE(value, width);
        assert.equal(bytes.length, width);
        assert.equal(api.toBigIntBE(bytes), value);
        assert.equal(api.toBigIntLE(api.toBufferLE(value, width)), value);
        assert.deepEqual(api.toBufferLE(value, width), Buffer.from(bytes).reverse());
      }
      assert.throws(() => api.toBufferLE(max + 1n, width), RangeError);
    }
    assert.equal(api.toBigIntLE(Buffer.alloc(0)), 0n);
    assert.throws(() => api.toBufferBE(-1n, 8), RangeError);
    assert.throws(() => api.toBufferLE(1n, -1), RangeError);
    assert.throws(() => api.toBufferLE(1n, Infinity), RangeError);
  });
}
