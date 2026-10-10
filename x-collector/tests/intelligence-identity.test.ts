import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {PoolClient} from 'pg';
import {
  ENTITY_TYPES,
  ObservationError,
  resolveEntities,
} from '../lib/intelligence/entity-resolution';
import {
  MissingEvidenceError,
  findIdentityCandidates,
  linkIdentity,
} from '../lib/intelligence/identity-matcher';
import {resolveEvidenceChain, resolveEvidenceSources} from '../lib/intelligence/evidence-resolver';

function fixture() {
  const db = new PGlite();
  const c = {query: (sql: string, args: unknown[] = []) => db.query(sql, args)} as unknown as Pick<PoolClient, 'query'>;
  return {db, c};
}

async function migrations(db: PGlite) {
  for (const name of ['023_intelligence_platform.sql', '024_intelligence_temporal.sql', '035_tag_taxonomy.sql']) {
    await db.exec(await fs.readFile('migrations/' + name, 'utf8'));
  }
}

async function rawEvent(db: PGlite, source = 'X'): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO ip_raw_events(id,source,event_type,external_id,payload,payload_hash,collected_at)
     VALUES($1,$2,'TWEET',$3,$4::jsonb,$5,now())`,
    [id, source, `event-${id}`, JSON.stringify({fixture: true}), `hash-${id}`],
  );
  return id;
}

const observation = (rawEventId: string, overrides: Record<string, unknown> = {}) => ({
  type: 'ACCOUNT' as const,
  platform: 'X',
  externalId: 'fixture-handle',
  name: '@fixture-handle',
  rawEventId,
  observedAt: new Date('2026-10-10T00:00:00Z'),
  ...overrides,
});

test('entity resolution collapses observations onto one entity keyed by type, platform and external id', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const first = await rawEvent(db);
    const second = await rawEvent(db);

    const resolved = await resolveEntities(c, [
      observation(first, {confidence: 0.6, metadata: {followers: 10}}),
      observation(second, {confidence: 0.9, name: '@fixture-handle', metadata: {verified: true}}),
      observation(first, {platform: 'X', externalId: 'fixture-handle', confidence: 0.7}),
    ]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].observations, 3);
    assert.equal(resolved[0].confidence, 0.9);
    assert.equal(resolved[0].externalId, 'fixture-handle');
    assert.deepEqual(resolved[0].metadata, {followers: 10, verified: true});

    const entities = await db.query<{id: string}>('SELECT id FROM ip_entities');
    assert.equal(entities.rows.length, 1);
    assert.equal(entities.rows[0].id, resolved[0].id);

    const again = await resolveEntities(c, [observation(first, {confidence: 0.4})]);
    assert.equal(again[0].id, resolved[0].id);
    assert.equal(again[0].observations, 1);
    assert.equal((await db.query('SELECT id FROM ip_entities')).rows.length, 1);
    assert.equal(ENTITY_TYPES.includes('WALLET'), true);
  } finally {
    await db.close();
  }
});

test('entity resolution refuses observations without evidence or with an invalid shape', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const evidence = await rawEvent(db);
    const missing = randomUUID();
    await assert.rejects(resolveEntities(c, []), ObservationError);
    await assert.rejects(resolveEntities(c, [observation(evidence, {type: 'ALIEN' as never})]), ObservationError);
    await assert.rejects(resolveEntities(c, [observation(evidence, {name: '   '})]), ObservationError);
    await assert.rejects(resolveEntities(c, [observation(evidence, {rawEventId: ''})]), ObservationError);
    await assert.rejects(resolveEntities(c, [observation(evidence, {confidence: 0})]), ObservationError);
    await assert.rejects(resolveEntities(c, [observation(evidence, {observedAt: new Date('nope')})]), ObservationError);
    await assert.rejects(resolveEntities(c, [observation(missing)]), /existing raw event/);
    assert.equal((await db.query('SELECT id FROM ip_entities')).rows.length, 0);
  } finally {
    await db.close();
  }
});

test('identity matching links accounts only when evidence exists', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const evidence = await rawEvent(db);
    const [x, telegram] = await resolveEntities(c, [
      observation(evidence),
      observation(evidence, {platform: 'TELEGRAM'}),
    ]);

    const withoutEvidence = await findIdentityCandidates(c);
    assert.equal(withoutEvidence.length, 1);
    assert.equal(withoutEvidence[0].evidence, null);
    assert.equal(withoutEvidence[0].platformA === 'X' || withoutEvidence[0].platformB === 'X', true);
    await assert.rejects(
      linkIdentity(c, {
        entityA: withoutEvidence[0].entityA,
        entityB: withoutEvidence[0].entityB,
        relation: 'SAME_HANDLE',
        confidence: 0.9,
        evidence: '',
        observedAt: new Date('2026-10-10T00:00:00Z'),
      }),
      MissingEvidenceError,
    );
    await assert.rejects(
      linkIdentity(c, {
        entityA: x.id,
        entityB: telegram.id,
        relation: 'SAME_HANDLE',
        confidence: 0.9,
        evidence: randomUUID(),
        observedAt: new Date('2026-10-10T00:00:00Z'),
      }),
      MissingEvidenceError,
    );
    assert.equal((await db.query('SELECT id FROM ip_identity_links')).rows.length, 0);

    await db.query(
      `INSERT INTO ip_behavior_events(id,actor_entity,event_type,timestamp,raw_event_id,external_id)
       VALUES($1,$2,'POST',$3,$4,$5)`,
      [randomUUID(), x.id, new Date('2026-10-10T00:00:00Z'), evidence, `post-${x.id}`],
    );
    const withEvidence = await findIdentityCandidates(c);
    assert.equal(withEvidence.length, 1);
    assert.equal(withEvidence[0].evidence, evidence);

    const linkId = await linkIdentity(c, {
      entityA: withEvidence[0].entityA,
      entityB: withEvidence[0].entityB,
      relation: 'SAME_HANDLE',
      confidence: withEvidence[0].confidence,
      evidence,
      observedAt: new Date('2026-10-10T00:00:00Z'),
    });
    const links = await db.query<{id: string; entity_a: string; entity_b: string; evidence: string}>(
      'SELECT id, entity_a, entity_b, evidence FROM ip_identity_links',
    );
    assert.equal(links.rows.length, 1);
    assert.equal(links.rows[0].id, linkId);
    assert.equal(links.rows[0].evidence, evidence);
    assert.equal(await linkIdentity(c, {
      entityA: withEvidence[0].entityA,
      entityB: withEvidence[0].entityB,
      relation: 'SAME_HANDLE',
      confidence: withEvidence[0].confidence,
      evidence,
      observedAt: new Date('2026-10-10T00:01:00Z'),
    }), linkId);
    assert.equal((await db.query('SELECT id FROM ip_identity_links')).rows.length, 1);
    await assert.rejects(
      linkIdentity(c, {
        entityA: x.id,
        entityB: x.id,
        relation: 'SAME_HANDLE',
        confidence: 0.9,
        evidence,
        observedAt: new Date('2026-10-10T00:00:00Z'),
      }),
      MissingEvidenceError,
    );
  } finally {
    await db.close();
  }
});

test('evidence resolver walks claim, source, confidence and timestamp as one chain', async () => {
  const {db, c} = fixture();
  try {
    await migrations(db);
    const raw = await rawEvent(db, 'https://fixture.invalid/source');
    const unknown = randomUUID();

    const verified = resolveEvidenceSources('wallet is controlled by one actor', [
      {rawEventId: raw, source: 'https://fixture.invalid/source', confidence: 0.8, observedAt: '2026-10-10T00:00:00Z'},
      {rawEventId: raw, source: 'https://fixture.invalid/source', confidence: 1, observedAt: '2026-10-09T00:00:00Z'},
    ]);
    assert.equal(verified.verified, true);
    assert.equal(verified.confidence, 0.8);
    assert.equal(verified.observedAt?.toISOString(), '2026-10-09T00:00:00.000Z');
    assert.deepEqual(verified.reasons, []);

    assert.equal(resolveEvidenceSources('', []).verified, false);
    const broken = resolveEvidenceSources('claim', [{rawEventId: '', observedAt: undefined}]);
    assert.equal(broken.verified, false);
    assert.equal(broken.confidence, 0);
    assert.ok(broken.reasons.includes('source_0_missing_raw_event'));

    const chained = await resolveEvidenceChain(c, 'claim', [raw]);
    assert.equal(chained.verified, true);
    assert.equal(chained.sources.length, 1);
    assert.equal(chained.sources[0].source, 'https://fixture.invalid/source');

    const unresolved = await resolveEvidenceChain(c, 'claim', [raw, unknown]);
    assert.equal(unresolved.verified, false);
    assert.ok(unresolved.reasons.includes(`unknown_raw_event:${unknown}`));

    const empty = await resolveEvidenceChain(c, 'claim', []);
    assert.equal(empty.verified, false);
    assert.ok(empty.reasons.includes('missing_source'));
  } finally {
    await db.close();
  }
});

test('tag taxonomy seeds the new categories and operational tags', async () => {
  const {db} = fixture();
  try {
    await migrations(db);
    const categories = await db.query<{id: string}>(
      `SELECT id FROM ip_tag_categories WHERE id IN ('IDENTITY','BEHAVIOR','INDUSTRY','NETWORK') ORDER BY id`,
    );
    assert.deepEqual(categories.rows.map((row) => row.id), ['BEHAVIOR', 'IDENTITY', 'INDUSTRY', 'NETWORK']);
    const tags = await db.query<{id: string; category_id: string}>(
      `SELECT id, category_id FROM ip_tags WHERE id IN ('high-risk','exchange') ORDER BY id`,
    );
    assert.deepEqual(tags.rows.map((row) => [row.id, row.category_id]), [['exchange', 'NETWORK'], ['high-risk', 'RISK']]);
    await assert.rejects(
      db.query(`INSERT INTO ip_tag_categories(id, name) VALUES ('IDENTITY', 'Identity')`),
      /duplicate key/,
    );
  } finally {
    await db.close();
  }
});
