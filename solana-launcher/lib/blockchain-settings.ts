import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { getDb } from './trade/db';
import { getHeliusApiKeys } from './trade/helius-rotation';
import { initDb,importFolders,refreshTargets,status,collect } from '../scripts/blockchain-seed-collector.cjs';
import { parseWorkbook } from '../scripts/blockchain-seed-core.cjs';
import { readFile } from '../scripts/xlsx-safe-package/index.cjs';
import { db as settingsDb,publicSettings } from '../scripts/blockchain-runtime.cjs';

export const categories=['migrated','dex_trending','profitable_wallets'] as const;
export function overview() {
  const database=getDb();initDb(database);
  const runs=settingsDb().prepare('SELECT * FROM blockchain_runs ORDER BY started_at DESC LIMIT 10').all();
  return { ...publicSettings(), heliusConfigured:getHeliusApiKeys().length>0, collection:status(database), runs,
    imports:settingsDb().prepare('SELECT id,name,category,status,records,invalid_rows,error,created_at FROM blockchain_imports ORDER BY created_at DESC LIMIT 30').all(),
    analytics:{ tokenTrades:database.prepare('SELECT COUNT(*) AS count FROM token_trades').get(),
      coverage:'provider_address_history_not_complete_chain', profitVerified:null, migrationVerified:null } };
}
export async function runBatch() {
  const database=getDb();initDb(database);
  return collect(database,{limit:100,concurrency:2,recentLimit:20,backfillLimit:20});
}
export function importUpload(category:string,name:string,bytes:Buffer) {
  if (!(categories as readonly string[]).includes(category) || !name.toLowerCase().endsWith('.xlsx')) throw new Error('invalid_import');
  const database=getDb();initDb(database);
  const sha=createHash('sha256').update(bytes).digest('hex');
  const previous=settingsDb().prepare("SELECT records,invalid_rows FROM blockchain_imports WHERE sha256=? AND category=? AND status='ok' LIMIT 1").get(sha,category);
  if (previous) return { duplicate:true, ...previous };
  const folder=path.join(process.cwd(),'data','chain-seeds',category);
  fs.mkdirSync(folder,{recursive:true});
  const file=path.join(folder,sha+'.xlsx');
  if (!fs.existsSync(file)) fs.writeFileSync(file,bytes,{flag:'wx'});
  else if (createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==sha) throw new Error('invalid_staged_file');
  const id=randomUUID();
  try {
    const parsed=parseWorkbook(readFile(file),category);
    if (!parsed.addresses.length && !parsed.sheets.some((s:{headerFound:boolean})=>s.headerFound)) throw new Error('invalid_structure');
    const imported=importFolders(database,{ folders:{[category]:folder},maxFiles:100000,dryRun:false,pruneMissing:false });
    if (!imported.changedFiles) refreshTargets(database);
    const invalid=parsed.sheets.reduce((n:number,s:{skipped:number})=>n+s.skipped,0);
    settingsDb().prepare('INSERT INTO blockchain_imports VALUES (?,?,?,?,?,?,?,?,?)').run(id,name.slice(0,120),category,sha,'ok',parsed.addresses.length,invalid,null,Date.now());
    return { id,records:parsed.addresses.length,invalidRows:invalid,changedFiles:imported.changedFiles,duplicate:false };
  } catch {
    if (!database.prepare('SELECT file_path FROM chain_seed_files WHERE file_path=?').get(file)) fs.rmSync(file,{force:true});
    settingsDb().prepare('INSERT INTO blockchain_imports VALUES (?,?,?,?,?,?,?,?,?)').run(id,name.slice(0,120),category,sha,'error',0,0,'xlsx_invalid',Date.now());
    throw new Error('xlsx_invalid');
  }
}
