// Preserve native import(): TypeScript's CommonJS emit rewrites it to require().
const fs = require('node:fs');
const path = require('node:path');
fs.copyFileSync(path.join(__dirname, 'xactions-http-loader.cjs'),
  path.join(__dirname, '../dist/scripts/xactions-http-loader.cjs'));
