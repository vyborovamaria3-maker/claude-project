'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const EXPECTED_SHA = 'b9c4bf7bd680f82d4ede0a1b48bb1c5dbfd7bb78';

/**
 * Native ESM loader for the pinned XActions checkout. The collector itself is
 * CommonJS. Deliberately opt-in: never import an arbitrary installed version.
 */
async function loadPinnedXActions(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('XActions: XACTIONS_ROOT must be an absolute checkout directory');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'xactions' || manifest.version !== '3.5.0') {
    throw new Error('XActions: the checkout must be XActions version 3.5.0');
  }
  // Version alone is insufficient: 3.5.0 may include later changes.
  // Require the exact tested source commit before executing third-party code.
  let sha;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('XActions: XACTIONS_ROOT must be a Git checkout at the pinned commit');
  }
  if (sha !== EXPECTED_SHA) {
    throw new Error('XActions: the checkout commit does not match the tested pinned version');
  }
  const entry = path.join(root, 'src', 'scrapers', 'twitter', 'http', 'index.js');
  const http = await import(pathToFileURL(entry).href);
  const tweetParser = await import(pathToFileURL(path.join(root, 'src', 'scrapers', 'twitter', 'http', 'parse', 'tweet.js')).href);
  const relationshipParser = await import(pathToFileURL(path.join(root, 'src', 'scrapers', 'twitter', 'http', 'relationships.js')).href);
  return {
    ...http,
    userTimelineInstructions: tweetParser.userTimelineInstructions,
    parseUserList: relationshipParser.parseUserList,
  };
}
module.exports = { loadPinnedXActions };
