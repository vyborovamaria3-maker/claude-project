const Database = require('better-sqlite3');
const dbPath = process.argv[2] || 'data/trade.db';
console.log('DB:', dbPath);
const db = new Database(dbPath, { readonly: true });

const tokenRows = db.prepare('SELECT COUNT(*) AS rows, COUNT(DISTINCT token_address) AS uniq FROM migration_token_rows').get();
const walletRows = db.prepare('SELECT COUNT(*) AS rows, COUNT(DISTINCT wallet) AS uniq FROM migration_wallet_rows').get();
const sheetsAsTokens = db.prepare('SELECT COUNT(DISTINCT sheet_name) AS uniqSheets FROM migration_wallet_rows').get();
const sampleSheets = db.prepare('SELECT sheet_name, COUNT(*) AS rows FROM migration_wallet_rows GROUP BY sheet_name ORDER BY rows DESC LIMIT 10').all();
const sheetsByFile = db.prepare('SELECT file_name, COUNT(DISTINCT sheet_name) AS sheets FROM migration_wallet_rows GROUP BY file_name ORDER BY sheets DESC LIMIT 5').all();
const xlsxSheets = db.prepare('SELECT SUM(sheet_count) AS totalSheets FROM migration_xlsx_files').get();
const filesProcessed = db.prepare('SELECT COUNT(*) AS files, SUM(token_rows) AS tokenRows, SUM(wallet_rows) AS walletRows FROM migration_xlsx_files').get();
const devMigrated = db.prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT mint) AS uniq FROM dev_tokens WHERE is_migrated = 1").get();
const dev300k = db.prepare("SELECT COUNT(*) AS rows FROM dev_tokens WHERE reached_300k = 1").get();

console.log('migration_token_rows:        ', tokenRows);
console.log('migration_wallet_rows:       ', walletRows);
console.log('unique sheets in wallet rows:', sheetsAsTokens);
console.log('xlsx files total sheets:     ', xlsxSheets);
console.log('top sheet_name samples:      ', sampleSheets);
console.log('files w/ most sheets:        ', sheetsByFile);
console.log('migration_xlsx_files totals: ', filesProcessed);
console.log('dev_tokens migrated:         ', devMigrated);
console.log('dev_tokens reached 300k:     ', dev300k);

const unionMigrated = db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT token_address AS m FROM migration_token_rows
    UNION
    SELECT mint AS m FROM dev_tokens WHERE is_migrated = 1
  )
`).get();
console.log('UNION unique migrated mints:', unionMigrated);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('\nALL tables:', tables.map(t => t.name).join(', '));

const candidates = ['dev_tokens', 'pumpfun_tokens', 'pumpfun_dataset', 'migration_token_rows', 'tokens'];
for (const t of tables) {
  if (!candidates.includes(t.name)) continue;
  try {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
    const has = (n) => cols.some(c => c.name === n);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get().n;
    let migrated = null, uniqMigrated = null;
    if (has('is_migrated')) {
      migrated = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE is_migrated = 1`).get().n;
      const idCol = has('mint') ? 'mint' : has('token_address') ? 'token_address' : null;
      if (idCol) uniqMigrated = db.prepare(`SELECT COUNT(DISTINCT ${idCol}) AS n FROM ${t.name} WHERE is_migrated = 1`).get().n;
    } else if (has('migrated')) {
      migrated = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE migrated = 1`).get().n;
    }
    console.log(`\n[${t.name}] total=${total} migrated=${migrated} uniqMigrated=${uniqMigrated}`);
  } catch (e) {
    console.log(`[${t.name}] error:`, e.message);
  }
}
