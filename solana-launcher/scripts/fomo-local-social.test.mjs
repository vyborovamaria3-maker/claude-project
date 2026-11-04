import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSocialSources, normalizeLocalSocialRows } from './fomo-local-social.mjs';

const mint = 'So11111111111111111111111111111111111111112';
const asOf = Date.parse('2026-10-26T12:00:00Z');
const xRow = (extra = {}) => ({ tweet_id: '123', handle: 'alice', text: `About ${mint}!`,
  posted_at: asOf - 1000, first_seen_at: asOf - 800, updated_at: asOf - 500,
  likes: '2', retweets: 1, replies: 3, views: '100', ...extra });
const tgRow = (extra = {}) => ({ source_id: '1', message_id: '2', identifier: 'channel_a',
  title: 'Channel A', text: `Discussing ${mint}`, posted_at: new Date(asOf - 1000),
  collected_at: new Date(asOf - 500), edited_at: null, deleted_at: null,
  engagement_observed_at: new Date(asOf - 400), views: 100, forwards: 2, ...extra });

test('uses exact case-sensitive mint and excludes future/unknown observation times', () => {
  const result = normalizeLocalSocialRows({ mint, asOf, xMatched: 1, tgMatched: 1,
    xRows: [xRow(), xRow({ text: `A${mint}` }), xRow({ text: mint.toLowerCase() }),
      xRow({ updated_at: asOf + 1 }), xRow({ posted_at: asOf - 25 * 3600000 }),
      xRow({ first_seen_at: undefined })],
    tgRows: [tgRow(), tgRow({ text: `${mint}A` }), tgRow({ collected_at: new Date(asOf + 1) }),
      tgRow({ edited_at: new Date(asOf + 1) }), tgRow({ deleted_at: new Date(asOf - 1) })] });
  assert.equal(result.x.topTweets.length, 1);
  assert.equal(result.tg.timeline.length, 1);
  assert.equal(result.x.aggregated.totalEngagement, 6);
  assert.equal(result.x.riskClassificationAvailable, false);
  assert.equal(result.x.botRiskScore, 50);
  assert.equal(result.provenance.coverage, 'partial');
  assert.equal(result.provenance.xLatestInputObservationAt, asOf - 500);
});

test('censors future engagement and bounds latest retained Telegram messages', () => {
  const tgRows = Array.from({ length: 205 }, (_, i) => tgRow({
    message_id: String(i), posted_at: new Date(asOf - 1000 - i),
    engagement_observed_at: new Date(asOf + 1),
  }));
  const result = normalizeLocalSocialRows({ mint, asOf, xRows: [], xMatched: 0,
    tgRows, tgMatched: 205 });
  assert.equal(result.tg.timeline.length, 200);
  assert.equal(result.tg.meta.truncated, true);
  assert.equal(result.tg.timeline[0].message_id, '199');
  assert.deepEqual(result.tg.timeline[0].metrics, {});
  assert.equal(result.x.totalTweets, 0);
  assert.equal(result.tg.meta.uniqueSourcesBeforeLimit, 1);
});

function fakePool(rows, fail = false) {
  const calls = [];
  let released = false;
  return { calls, get released() { return released; },
    async connect() { return {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.startsWith('WITH') && fail) throw new Error('secret-password@host');
        return { rows: sql.startsWith('WITH') ? rows : [] };
      },
      release() { released = true; },
    }; },
  };
}

test('capture uses fixed parameters in read-only transactions and real empty results', async () => {
  const x = fakePool([xRow({ matched_count: 4 })]);
  const tg = fakePool([]);
  const sources = createLocalSocialSources({ xPool: x, tgPool: tg });
  const result = await sources.capture(mint, { asOf });
  assert.equal(result.x.totalTweets, 1);
  assert.equal(result.x.meta.matchedBeforeLimit, 4);
  assert.equal(result.tg.mentions, 0);
  for (const pool of [x, tg]) {
    assert.match(pool.calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.equal(pool.calls.at(-1).sql, 'COMMIT');
    assert.equal(pool.released, true);
  }
  assert.deepEqual(x.calls.find((c) => c.values).values.slice(1), [asOf - 24 * 3600000, asOf]);
  assert.match(tg.calls.find((c) => c.values).sql, /collected_at <= \$3/);
});

test('query failures fail the capture and redact database details', async () => {
  const x = fakePool([], true);
  const tg = fakePool([]);
  const sources = createLocalSocialSources({ xPool: x, tgPool: tg });
  await assert.rejects(sources.capture(mint, { asOf }), { message: 'x_source_unavailable' });
  assert.equal(x.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(x.released, true);
});

test('watchlist prioritizes exact recent Telegram matches of known Fomo tokens only', async () => {
  const other = 'J9WL4zQVCFvLTydjtHoMGcLasjhRMZomnVmp4Y2cpump';
  const unknown = '4qwHaobYN4FQ2w3nqW1F4H5j4nEgLeyzvvwpy8o7PJM9';
  const makePool = (query) => ({ async connect() { return { query, release() {} }; } });
  const x = makePool(async (sql) => ({ rows: sql.startsWith('SELECT * FROM')
    ? [mint, other].map((value) => ({ payload: { token: { address: value }, ts: asOf - 1 } }))
    : sql.includes('posted_at AS latest_posted_at') ? [{ latest_posted_at: asOf - 100 }]
      : sql.includes('AS posts_24h') ? [{ posts_24h: 9 }] : [] }));
  const tg = makePool(async (sql) => ({ rows: sql.startsWith('SELECT text')
    ? [{ text: `${other} ${unknown}`, posted_at: new Date(asOf - 1) },
      { text: `A${mint}`, posted_at: new Date(asOf - 2) }] : [] }));
  const sources = createLocalSocialSources({ xPool: x, tgPool: tg });
  assert.deepEqual(await sources.watchlist({ limit: 2, asOf }), [other, mint]);
  assert.equal(sources.status().knownFomoTokensWithRecentTelegram, 1);
  assert.equal(sources.status().xPosts24h, 9);
});
