import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {PoolClient} from 'pg';
import {ingestTransaction} from '../lib/trade/intelligence-blockchain';
import {resolveEntity} from '../lib/trade/intelligence-store';
import {
  BlockchainAdapter,
  ChainValidationError,
  normalizeAddress,
  normalizeTransactionHash,
  validateAddress,
  validateTransactionHash,
} from '../lib/intelligence/chain-adapter';
import {
  ChainNotRegisteredError,
  createDatabaseAdapter,
  createDefaultRegistry,
} from '../lib/intelligence/chain-registry';
import {
  MissingEvidenceError,
  findCrossChainCandidates,
  linkCrossChain,
} from '../lib/intelligence/cross-chain-correlator';

const ETH_ADDRESS_A = '0x' + 'a'.repeat(40);
const ETH_ADDRESS_B = '0x' + 'b'.repeat(40);
const SOL_ADDRESS_A = '7'.repeat(44);
const SOL_ADDRESS_B = '8'.repeat(44);
const BTC_ADDRESS_A = 'bc1q' + 'q'.repeat(30);
const BTC_ADDRESS_B = '1'.repeat(34);
const ETH_HASH = '0x' + 'c'.repeat(64);
const SOL_SIGNATURE = '9'.repeat(88);
const BTC_HASH = 'd'.repeat(64);

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

const ethTx = (hash = ETH_HASH, from = ETH_ADDRESS_A, to = ETH_ADDRESS_B) => ({
  chain: 'ethereum' as const, hash, from, to, token: null, amount: '1.5',
  timestamp: '2026-10-10T00:00:00Z', source: 'https://fixture.invalid/eth', payload: {fixture: true},
});
const solTx = (signature = SOL_SIGNATURE, from = SOL_ADDRESS_A, to = SOL_ADDRESS_B) => ({
  chain: 'solana' as const, hash: signature, from, to, token: null, amount: '2',
  timestamp: '2026-10-10T00:01:00Z', source: 'https://fixture.invalid/sol', payload: {fixture: true},
});

test('chain registry serves db-backed adapters and rejects unknown chains', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const eth = await ingestTransaction(c, ethTx());
    const sol = await ingestTransaction(c, solTx());

    const registry = createDefaultRegistry(c);
    assert.deepEqual(registry.supportedChains(), ['ethereum', 'solana', 'bitcoin']);
    assert.deepEqual(registry.registeredChains(), ['ethereum', 'solana', 'bitcoin']);
    assert.ok(registry.has('ethereum'));
    assert.throws(() => registry.getAdapter('dogecoin'), ChainNotRegisteredError);

    const empty = createDefaultRegistry(c);
    empty.unregister('bitcoin');
    assert.deepEqual(empty.registeredChains(), ['ethereum', 'solana']);
    assert.throws(() => empty.getAdapter('bitcoin'), ChainNotRegisteredError);

    const adapter: BlockchainAdapter = registry.getAdapter('ethereum');
    const transaction = await adapter.getTransaction(ETH_HASH);
    assert.ok(transaction);
    assert.equal(transaction.chain, 'ethereum');
    assert.equal(transaction.hash, ETH_HASH);
    assert.equal(transaction.from, ETH_ADDRESS_A);
    assert.equal(transaction.to, ETH_ADDRESS_B);
    assert.equal(transaction.rawEventId, eth.raw_event_id);
    assert.equal(await adapter.getTransaction('0x' + 'f'.repeat(64)), null);

    const wallet = await adapter.getWallet(ETH_ADDRESS_A.toUpperCase().replace('0X', '0x'));
    assert.ok(wallet);
    assert.equal(wallet.entityId, eth.from_entity);
    assert.equal(wallet.chain, 'ethereum');
    assert.equal(wallet.rawEventId, eth.raw_event_id);
    assert.equal(await adapter.getBalance(ETH_ADDRESS_A), null);
    assert.equal(await adapter.getWallet('0x' + 'd'.repeat(40)), null);
    await assert.rejects(adapter.getWallet('not-an-address'), ChainValidationError);

    const solWallet = await registry.getAdapter('solana').getWallet(SOL_ADDRESS_A);
    assert.ok(solWallet);
    assert.equal(solWallet.entityId, sol.from_entity);
    assert.equal(await registry.getAdapter('bitcoin').getWallet(BTC_ADDRESS_A), null);
    assert.equal(await registry.getAdapter('bitcoin').getTransaction(BTC_HASH), null);
  } finally {
    await db.close();
  }
});

test('chain validation matches the per-chain address and hash rules', () => {
  assert.equal(validateAddress('ethereum', ETH_ADDRESS_A), true);
  assert.equal(validateAddress('ethereum', ETH_ADDRESS_A.toUpperCase().replace('0X', '0x')), true);
  assert.equal(validateAddress('ethereum', '0x' + 'g'.repeat(40)), false);
  assert.equal(validateAddress('ethereum', '7'.repeat(44)), false);
  assert.equal(normalizeAddress('ethereum', '0x' + 'AB'.repeat(20)), '0x' + 'ab'.repeat(20));

  assert.equal(validateAddress('solana', SOL_ADDRESS_A), true);
  assert.equal(validateAddress('solana', '0lOIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0O'), false);
  assert.equal(validateAddress('solana', 'a'.repeat(31)), false);
  assert.equal(normalizeAddress('solana', SOL_ADDRESS_A), SOL_ADDRESS_A);

  assert.equal(validateAddress('bitcoin', BTC_ADDRESS_A), true);
  assert.equal(validateAddress('bitcoin', BTC_ADDRESS_A.toUpperCase()), true);
  assert.equal(validateAddress('bitcoin', 'bc1q' + 'Q'.repeat(30)), false);
  assert.equal(validateAddress('bitcoin', BTC_ADDRESS_B), true);
  assert.equal(validateAddress('bitcoin', '0OIl'), false);
  assert.equal(validateAddress('bitcoin', 'bc1q'), false);
  assert.equal(normalizeAddress('bitcoin', BTC_ADDRESS_A.toUpperCase()), BTC_ADDRESS_A);
  assert.equal(normalizeAddress('bitcoin', BTC_ADDRESS_B), BTC_ADDRESS_B);

  assert.equal(validateTransactionHash('ethereum', ETH_HASH), true);
  assert.equal(validateTransactionHash('solana', SOL_SIGNATURE), true);
  assert.equal(validateTransactionHash('bitcoin', BTC_HASH), true);
  assert.equal(validateTransactionHash('bitcoin', '0x' + 'a'.repeat(64)), false);
  assert.equal(normalizeTransactionHash('ethereum', '0x' + 'AB'.repeat(32)), '0x' + 'ab'.repeat(32));
  assert.equal(normalizeTransactionHash('bitcoin', BTC_HASH.toUpperCase()), BTC_HASH);
  assert.throws(() => normalizeAddress('ethereum', 'nope'), ChainValidationError);
  assert.throws(() => normalizeTransactionHash('solana', 'short'), ChainValidationError);
});

test('cross-chain wallets link only through an existing raw event', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const eth = await ingestTransaction(c, ethTx());
    const sol = await ingestTransaction(c, solTx());

    await c.query(
      `INSERT INTO ip_blockchain_transactions(hash,chain,from_entity,to_entity,amount,timestamp,raw_event_id)
       VALUES($1,'bitcoin',$2,$3,1,$4,$5)`,
      [BTC_HASH, eth.from_entity, sol.from_entity, new Date('2026-10-10T00:02:00Z'), eth.raw_event_id],
    );
    await c.query(`UPDATE ip_entities SET metadata = '{"owner":"fixture-owner"}' WHERE id IN ($1,$2)`, [
      eth.from_entity, sol.from_entity,
    ]);

    const candidates = await findCrossChainCandidates(c);
    const isPair = (candidate: {sourceEntityId: string; targetEntityId: string}, a: string, b: string) =>
      (candidate.sourceEntityId === a && candidate.targetEntityId === b) ||
      (candidate.sourceEntityId === b && candidate.targetEntityId === a);
    const candidate = candidates.find((row) => isPair(row, eth.from_entity, sol.from_entity));
    assert.ok(candidate);
    assert.equal(candidate.reason, 'SHARED_RAW_EVENT');
    assert.equal(candidate.confidence, 1);
    assert.equal(candidate.rawEventId, eth.raw_event_id);
    assert.equal(candidate.sourceChain === 'ethereum' || candidate.targetChain === 'ethereum', true);
    assert.equal(candidate.sourceChain === 'solana' || candidate.targetChain === 'solana', true);
    assert.equal(candidates.every((row) => row.rawEventId !== null), true);

    const relationId = await linkCrossChain(c, candidate);
    const relations = await db.query<{id: string; source_event_id: string; confidence: number}>(
      `SELECT id, source_event_id, confidence FROM ip_entity_relations WHERE relation_type = 'CONNECTED_BY_PATTERN'`,
    );
    assert.equal(relations.rows.length, 1);
    assert.equal(relations.rows[0].id, relationId);
    assert.equal(relations.rows[0].source_event_id, eth.raw_event_id);
    assert.equal(Number(relations.rows[0].confidence), 1);
    assert.equal(
      (await db.query(`SELECT id FROM ip_relation_evidence WHERE relation_id = $1`, [relationId])).rows.length,
      1,
    );
    assert.equal(await linkCrossChain(c, candidate), relationId);
    assert.equal(
      (await db.query(`SELECT id FROM ip_entity_relations WHERE relation_type = 'CONNECTED_BY_PATTERN'`)).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});

test('cross-chain correlation refuses to link wallets without evidence', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const eth = await resolveEntity(c, 'WALLET', 'ethereum', ETH_ADDRESS_A, ETH_ADDRESS_A);
    const sol = await resolveEntity(c, 'WALLET', 'solana', SOL_ADDRESS_A, SOL_ADDRESS_A);
    await c.query(`UPDATE ip_entities SET metadata = '{"owner":"shared-owner"}' WHERE id IN ($1,$2)`, [eth, sol]);

    const candidates = await findCrossChainCandidates(c);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].rawEventId, null);
    assert.equal(candidates[0].reason, 'SHARED_METADATA');
    assert.equal(candidates[0].confidence, 0.5);
    await assert.rejects(linkCrossChain(c, candidates[0]), MissingEvidenceError);
    await assert.rejects(
      linkCrossChain(c, {...candidates[0], rawEventId: '00000000-0000-0000-0000-000000000000'}),
      MissingEvidenceError,
    );
    assert.equal(
      (await db.query(`SELECT id FROM ip_entity_relations WHERE relation_type = 'CONNECTED_BY_PATTERN'`)).rows.length,
      0,
    );
    assert.equal((await db.query(`SELECT id FROM ip_relation_evidence`)).rows.length, 0);
  } finally {
    await db.close();
  }
});

test('database adapter is created per supported chain', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    for (const chain of ['ethereum', 'solana', 'bitcoin'] as const) {
      assert.equal(createDatabaseAdapter(c, chain).chain, chain);
    }
    assert.throws(() => createDatabaseAdapter(c, 'dogecoin'), ChainValidationError);
    assert.equal(createDefaultRegistry(c).registeredChains().length, 3);
  } finally {
    await db.close();
  }
});
