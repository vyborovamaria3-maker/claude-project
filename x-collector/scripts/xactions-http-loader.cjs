'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
  const entry = path.join(root, 'src', 'scrapers', 'twitter', 'http', 'index.js');
  return import(pathToFileURL(entry).href);
}
module.exports = { loadPinnedXActions };
