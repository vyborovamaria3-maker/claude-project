import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {PoolClient} from 'pg';
import {ingestTransaction} from '../lib/trade/intelligence-blockchain';
import {
  ChainValidationError,
  assertSupportedChain,
  isSupportedChain,
  normalizeAddress,
  normalizeTransactionHash,
  validateAddress,
  validateTransactionHash,
  type SupportedChain,
} from '../lib/intelligence/chain-adapter';
import {
  ChainNotRegisteredError,
  createDatabaseAdapter,
  createDefaultRegistry,
} from '../lib/intelligence/chain-registry';

const SOL_ADDRESS_A = '1'.repeat(32);
const SOL_ADDRESS_B = 'So11111111111111111111111111111111111111112';
const SOL_SIGNATURE = '1'.repeat(64);

function fixture() {
  const db = new PGlite();
  const c = {query: (sql: string, args: unknown[] = []) => db.query(sql, args)} as unknown as Pick<PoolClient, 'query'>;
  return {db, c};
}

async function migrations(db: PGlite) {
  for (const name of ['023_intelligence_platform.sql', '024_intelligence_temporal.sql']) {
    await db.exec(await fs.readFile('migrations/' + name, 'utf8'));
  }
}

const solTx = (signature = SOL_SIGNATURE, from = SOL_ADDRESS_A, to = SOL_ADDRESS_B) => ({
  chain: 'solana' as const, hash: signature, from, to, token: null, amount: '2',
  timestamp: '2026-10-10T00:01:00Z', source: 'https://fixture.invalid/sol', payload: {fixture: true},
});

test('chain registry exposes only Solana and reads persisted Solana evidence', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const saved = await ingestTransaction(c, solTx());

    const registry = createDefaultRegistry(c);
    assert.deepEqual(registry.supportedChains(), ['solana']);
    assert.deepEqual(registry.registeredChains(), ['solana']);
    assert.ok(registry.has('solana'));
    assert.equal(registry.has('ethereum'), false);
    assert.equal(registry.has('bitcoin'), false);
    assert.throws(() => registry.getAdapter('ethereum'), ChainNotRegisteredError);
    assert.throws(() => registry.getAdapter('bitcoin'), ChainNotRegisteredError);

    const adapter = registry.getAdapter('solana');
    const transaction = await adapter.getTransaction(SOL_SIGNATURE);
    assert.ok(transaction);
    assert.equal(transaction.chain, 'solana');
    assert.equal(transaction.hash, SOL_SIGNATURE);
    assert.equal(transaction.from, SOL_ADDRESS_A);
    assert.equal(transaction.to, SOL_ADDRESS_B);
    assert.equal(transaction.rawEventId, saved.raw_event_id);

    const wallet = await adapter.getWallet(SOL_ADDRESS_A);
    assert.ok(wallet);
    assert.equal(wallet.entityId, saved.from_entity);
    assert.equal(wallet.chain, 'solana');
    assert.equal(wallet.rawEventId, saved.raw_event_id);
    assert.equal(await adapter.getBalance(SOL_ADDRESS_A), null);
    await assert.rejects(adapter.getTransaction('1'.repeat(63)), ChainValidationError);
  } finally {
    await db.close();
  }
});

test('Solana address and transaction signature validation checks decoded byte lengths', () => {
  assert.equal(isSupportedChain('solana'), true);
  assert.equal(isSupportedChain('ethereum'), false);
  assert.equal(isSupportedChain('bitcoin'), false);
  assert.equal(assertSupportedChain('solana'), 'solana');
  assert.throws(() => assertSupportedChain('ethereum'), ChainValidationError);
  assert.throws(() => assertSupportedChain('bitcoin'), ChainValidationError);

  assert.equal(validateAddress('solana', SOL_ADDRESS_A), true);
  assert.equal(validateAddress('solana', SOL_ADDRESS_B), true);
  assert.equal(validateAddress('solana', '1'.repeat(31)), false);
  assert.equal(validateAddress('solana', '0OIl' + '1'.repeat(28)), false);
  assert.equal(normalizeAddress('solana', SOL_ADDRESS_A), SOL_ADDRESS_A);

  assert.equal(validateTransactionHash('solana', SOL_SIGNATURE), true);
  assert.equal(validateTransactionHash('solana', '1'.repeat(63)), false);
  assert.equal(normalizeTransactionHash('solana', SOL_SIGNATURE), SOL_SIGNATURE);
  assert.throws(() => normalizeAddress('ethereum' as SupportedChain, '0x' + 'a'.repeat(40)), ChainValidationError);
  assert.throws(() => normalizeTransactionHash('bitcoin' as SupportedChain, 'a'.repeat(64)), ChainValidationError);
});

test('new blockchain imports reject non-Solana networks before any database write', async () => {
  const calls: string[] = [];
  const c = {
    query: async (sql: string) => {
      calls.push(sql);
      return {rows: []};
    },
  } as unknown as Pick<PoolClient, 'query'>;

  await assert.rejects(ingestTransaction(c, {...solTx(), chain: 'ethereum', hash: '0x' + 'a'.repeat(64)}));
  await assert.rejects(ingestTransaction(c, {...solTx(), chain: 'bitcoin', hash: 'a'.repeat(64)}));
  assert.equal(calls.length, 0);
});

test('database adapter can only be created for Solana', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    assert.equal(createDatabaseAdapter(c, 'solana').chain, 'solana');
    assert.throws(() => createDatabaseAdapter(c, 'ethereum'), ChainValidationError);
    assert.throws(() => createDatabaseAdapter(c, 'bitcoin'), ChainValidationError);
    assert.equal(createDefaultRegistry(c).registeredChains().length, 1);
  } finally {
    await db.close();
  }
});
