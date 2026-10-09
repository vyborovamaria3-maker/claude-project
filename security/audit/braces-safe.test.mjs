import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const braces = require('../../solana-subscription-service/packages/braces-safe');

test('brace expressions retain ranges, alternatives and escaping', () => {
  assert.deepEqual(braces.expand('a/{b,c}/{1..3}'), ['a/b/1', 'a/b/2', 'a/b/3', 'a/c/1', 'a/c/2', 'a/c/3']);
  assert.equal(braces.compile('a/{b,c}/d'), 'a/(b|c)/d');
  assert.equal(braces.stringify(braces.parse('a/{b,c}/d')), 'a/{b,c}/d');
  assert.deepEqual(braces.expand('a/\\{b,c\\}/d'), ['a/{b,c}/d']);
});

test('deep patterns are rejected before exhausting the JavaScript stack', () => {
  const pattern = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    assert.throws(() => braces[method](pattern), /exceeds safe depth/);
  }
});

test('public AST walkers also enforce depth limits', () => {
  let ast = { type: 'text', value: 'x', nodes: [] };
  for (let i = 0; i < 10000; i++) ast = { type: 'root', nodes: [ast] };
  for (const method of ['compile', 'expand', 'stringify']) {
    assert.throws(() => braces[method](ast), /exceeds safe depth/);
  }
});
