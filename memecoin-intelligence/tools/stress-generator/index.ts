import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';

function integerArg(name: string, fallback: number) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function stringArg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const posts = integerArg('posts', 100_000);
const accounts = Math.min(integerArg('accounts', Math.max(100, Math.floor(posts / 10))), posts);
const tokens = Math.min(integerArg('tokens', Math.max(10, Math.floor(posts / 100))), 100_000);
const coordinatedShare = Math.min(0.8, integerArg('coordinated-percent', 18) / 100);
const seed = integerArg('seed', 42);
const output = resolve(stringArg('output', `fixtures/generated/posts-${posts}.ndjson`));

let state = seed >>> 0;
function random() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 0x1_0000_0000;
}
function int(max: number) { return Math.floor(random() * max); }
function base58(length: number) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = '';
  for (let index = 0; index < length; index += 1) value += alphabet[int(alphabet.length)];
  return value;
}

const addresses = Array.from({ length: tokens }, (_, index) => `${base58(36)}${index % 7 === 0 ? 'pump' : base58(4)}`.slice(0, 44));
const campaignTemplates = [
  'Early call: ${ticker} CA ${address} community https://t.me/alpha_room #solana',
  '${ticker} is moving. Contract ${address} same team, watch volume https://dexscreener.com/solana/${address}',
  'Found ${ticker} before the crowd ${address} #memecoin #solana',
];
const organicTemplates = [
  'Looking at ${ticker}; liquidity seems ${adjective}. CA ${address}',
  'Does anyone know the team behind ${ticker}? ${address}',
  '${ticker} update: volume changed, not financial advice. ${address}',
  'Tracking ${ticker} after seeing it on-chain. Contract ${address}',
];
const adjectives = ['thin', 'healthy', 'volatile', 'unclear', 'interesting', 'risky'];
const startedAt = Date.now() - posts * 1_000;

mkdirSync(resolve(output, '..'), { recursive: true });
const stream = createWriteStream(output, { encoding: 'utf8', highWaterMark: 1 << 20 });
let coordinated = 0;
for (let index = 0; index < posts; index += 1) {
  const tokenIndex = int(tokens);
  const accountIndex = int(accounts);
  const isCoordinated = random() < coordinatedShare;
  if (isCoordinated) coordinated += 1;
  const ticker = `$MEME${tokenIndex}`;
  const address = addresses[tokenIndex];
  const template = isCoordinated ? campaignTemplates[tokenIndex % campaignTemplates.length] : organicTemplates[int(organicTemplates.length)];
  const text = template
    .replaceAll('${ticker}', ticker)
    .replaceAll('${address}', address)
    .replaceAll('${adjective}', adjectives[int(adjectives.length)]);
  const timestamp = isCoordinated
    ? startedAt + Math.floor(index / 50) * 60_000 + int(45_000)
    : startedAt + index * 1_000 + int(120_000);
  const followers = Math.floor(Math.pow(random(), 3) * 250_000);
  const row = {
    id: `stress-${seed}-${index}`,
    url: `https://x.com/user_${accountIndex}/status/${index}`,
    text,
    createdAt: new Date(timestamp).toISOString(),
    likes: int(Math.max(2, Math.floor(followers / 100))),
    retweets: int(Math.max(2, Math.floor(followers / 500))),
    replies: int(20), quotes: int(10), views: int(Math.max(10, followers * 2 + 100)),
    author: {
      handle: `user_${accountIndex}`, name: `Stress User ${accountIndex}`,
      followers, following: int(3_000), posts: int(50_000),
      isVerified: followers > 50_000,
      joinedAt: new Date(Date.UTC(2016 + (accountIndex % 10), accountIndex % 12, 1)).toISOString(),
    },
    truth: { coordinated: isCoordinated, tokenIndex },
  };
  if (!stream.write(`${JSON.stringify(row)}\n`)) await once(stream, 'drain');
}
stream.end();
await once(stream, 'finish');

const manifest = {
  version: 1, seed, posts, accounts, tokens, coordinatedPosts: coordinated,
  coordinatedShare: coordinated / posts, output, generatedAt: new Date().toISOString(),
};
writeFileSync(`${output}.manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
