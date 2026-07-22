const path = require('node:path');

process.chdir(path.join(__dirname, 'solana-launcher'));
require('./solana-launcher/scripts/db-report.cjs');
