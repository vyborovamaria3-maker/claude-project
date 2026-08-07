import { createReadStream, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { extractPostFeatures } from '../../src/server/xanalysis/features.js';
import { analyzeAccountNetwork } from '../../src/server/xanalysis/network.js';
import type { XMention } from '../../src/server/xanalysis/xsearch.js';
import { Profiler } from '../../src/performance/profiler.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
function latestGenerated() {
  const files = readdirSync('fixtures/generated').filter((file) => file.endsWith('.ndjson')).sort();
  if (!files.length) throw new Error('Generate data first with npm run generate:data');
  return resolve('fixtures/generated', files.at(-1)!);
}
function toMention(raw: any): XMention {
  const author = raw.author ?? {}; const createdAt = new Date(raw.createdAt);
  const likes = Number(raw.likes ?? 0); const retweets = Number(raw.retweets ?? 0); const replies = Number(raw.replies ?? 0); const quotes = Number(raw.quotes ?? 0);
  return {
    id: String(raw.id), url: String(raw.url), text: String(raw.text), createdAt: Number.isFinite(createdAt.getTime()) ? createdAt : null,
    likes, retweets, replies, quotes, views: Number(raw.views ?? 0), engagement: likes + retweets + replies + quotes,
    author: {
      handle: String(author.handle), name: String(author.name ?? author.handle), profileUrl: `https://x.com/${author.handle}`,
      avatarUrl: null, followers: Number(author.followers ?? 0), following: Number(author.following ?? 0), posts: Number(author.posts ?? 0),
      isVerified: Boolean(author.isVerified), verifiedType: null, bio: null,
      joinedAt: author.joinedAt ? new Date(author.joinedAt) : null,
    },
  };
}

const file = resolve(arg('file') ?? latestGenerated());
const sampleSize = Math.max(100, Number(arg('network-sample') ?? 5_000));
const profiler = new Profiler();
const sample: XMention[] = [];
let rows = 0; let contracts = 0; let links = 0; let words = 0; let coordinatedTruth = 0;

profiler.start('stream-and-features');
const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const raw = JSON.parse(line);
  const features = extractPostFeatures(String(raw.text ?? ''));
  rows += 1; contracts += features.contracts.length; links += features.links.length; words += features.words.length;
  if (raw.truth?.coordinated) coordinatedTruth += 1;
  if (sample.length < sampleSize) sample.push(toMention(raw));
}
const featureMetric = profiler.end('stream-and-features')!;

profiler.start('network');
const address = extractPostFeatures(sample[0]?.text ?? '').contracts[0] ?? '11111111111111111111111111111111';
const network = analyzeAccountNetwork(sample, {
  address, symbol: 'MEME0', maxCandidatePairs: 500_000, maxFeatureFanout: 180, timeBucketMinutes: 5,
});
const networkMetric = profiler.end('network')!;
const memory = process.memoryUsage();
const report = {
  version: '3.2.0', file, dataset: { rows, sampleRows: sample.length, coordinatedTruth, contracts, links, words },
  throughput: {
    featureRowsPerSecond: Math.round(rows / Math.max(0.001, featureMetric.durationMs / 1_000)),
    networkRowsPerSecond: Math.round(sample.length / Math.max(0.001, networkMetric.durationMs / 1_000)),
  },
  timingsMs: { featureExtraction: featureMetric.durationMs, network: networkMetric.durationMs },
  network: {
    nodes: network.nodeCount, edges: network.edgeCount, clusters: network.clusterCount,
    candidatePairs: network.candidatePairCount, possiblePairs: network.possiblePairCount,
    pruningPercent: Number((network.pruningRatio * 100).toFixed(2)), coordinationScore: network.coordinationScore,
  },
  memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external },
  profile: profiler.report(), generatedAt: new Date().toISOString(),
};
writeFileSync('benchmark-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
