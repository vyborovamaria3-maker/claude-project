import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'network-test-'));
for (const name of ['features', 'network']) {
  const source = fs.readFileSync(`src/server/xanalysis/${name}.ts`, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: `${name}.ts`, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  fs.writeFileSync(path.join(directory, `${name}.js`), output);
}
fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
const { analyzeAccountNetwork } = await import(pathToFileURL(path.join(directory, 'network.js')));

const author = (handle) => ({ handle, name: handle, profileUrl: `https://x.com/${handle}`, avatarUrl: null, followers: 100, following: 0, posts: 1, isVerified: false, verifiedType: null, bio: null, joinedAt: null });
const mention = (id, handle, text, createdAt) => ({ id, url: `https://x.com/${handle}/status/${id}`, text, createdAt, likes: 0, retweets: 0, replies: 0, quotes: 0, views: 0, engagement: 0, author: author(handle) });
const address = '11111111111111111111111111111111';

let result = analyzeAccountNetwork([], { address, symbol: 'TEST' });
assert.equal(result.nodeCount, 0);
assert.equal(result.likelyOriginator, null);
assert.equal(result.candidatePairCount, 0);

result = analyzeAccountNetwork([
  mention('1', 'a', `${address} same launch text #moon`, new Date('2026-07-31T10:00:00Z')),
  mention('2', 'b', `${address} same launch text #moon`, new Date('2026-07-31T10:02:00Z')),
  mention('3', 'c', '$TEST same launch text #moon', new Date('2026-07-31T10:05:00Z')),
], { address, symbol: 'TEST' });
assert.equal(result.likelyOriginator, 'a');
assert.equal(result.medianPropagationDelayMinutes, 2.5);
assert.ok(result.edgeCount > 0);
assert.ok(result.pruningRatio >= 0 && result.pruningRatio <= 1);
console.log('Network tests OK');
