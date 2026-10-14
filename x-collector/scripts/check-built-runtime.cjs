// Import the compiled default collector path without an SDK checkout or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
assert.ok(fs.existsSync(path.join(root, 'dist/scripts/xactions-http-loader.cjs')),
  'Build must package the XActions CJS loader');
assert.equal(fs.readFileSync(path.join(root, 'dist/scripts/xactions-http-loader.cjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'scripts/xactions-http-loader.cjs'), 'utf8'),
  'Build must preserve native ESM imports in the CJS loader');
require(path.join(root, 'dist/src/runtime/collector-task.js'));
console.log('Compiled collector runtime import passed');
