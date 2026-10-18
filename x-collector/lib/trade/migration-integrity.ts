import {createHash} from 'node:crypto';

export interface MigrationFile {filename:string;sql:string}
export interface MigrationConnection {
  query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>
}

/** Checkout line endings differ on Windows; SQL content, including whitespace,
 * otherwise remains significant. Never rewrite the executed SQL. */
export function migrationChecksum(sql:string):string {
  return createHash('sha256').update(sql.replace(/\r\n/g,'\n'),'utf8').digest('hex');
}

export async function runMigrations(c:MigrationConnection,files:MigrationFile[],options:{statusOnly?:boolean;baseline?:boolean;log?:(line:string)=>void}={}) {
  if(options.statusOnly&&options.baseline)throw Error('Cannot combine --status and --baseline-checksums');
  const log=options.log??(()=>{});
  const exists=(await c.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present")).rows[0]?.present===true;
  // to_jsonb works against both legacy and checksum-aware ledgers, read-only.
  const rows=exists?(await c.query("SELECT filename,to_jsonb(m)->>'checksum' AS checksum FROM schema_migrations m")).rows:[];
  const ledger=new Map(rows.map(row=>[String(row.filename),row.checksum==null?null:String(row.checksum)]));
  const known=new Set(files.map(file=>file.filename));
  for(const filename of ledger.keys())if(!known.has(filename))throw Error('Unknown applied migration: '+filename+'; reconcile the ledger before migrating');
  const hashes=new Map(files.map(file=>[file.filename,migrationChecksum(file.sql)]));
  // Validate every applied file before DDL, baselining or pending migrations.
  for(const [filename,checksum] of ledger)if(checksum!==null&&checksum!==hashes.get(filename))throw Error('Migration checksum drift: '+filename+'; restore the original SQL, do not overwrite the stored checksum');
  for(const file of files)log(`[${!ledger.has(file.filename)?'pending':ledger.get(file.filename)===null?'unverified':'applied'}] ${file.filename}`);
  if(options.statusOnly)return;
  if([...ledger.values()].includes(null)&&!options.baseline)throw Error('Legacy migration checksums are unverified. Compare SQL with deployment backups, then run migrate --baseline-checksums explicitly');
  if(options.baseline&&!exists)throw Error('No existing migration ledger to baseline; run migrate normally');
  await c.query('BEGIN');
  try{
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT)');
    await c.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    if(options.baseline)for(const [filename,checksum] of ledger)if(checksum===null)await c.query('UPDATE schema_migrations SET checksum=$2 WHERE filename=$1 AND checksum IS NULL',[filename,hashes.get(filename)]);
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
  // Baseline only acknowledges the explicitly reviewed legacy ledger. It must
  // not also apply pending SQL or silently bless changed known checksums.
  if(options.baseline){log('Legacy checksum baseline recorded; no pending migrations applied.');return;}
  for(const file of files){
    if(ledger.has(file.filename))continue;
    await c.query('BEGIN');
    try{
      await c.query(file.sql);
      await c.query('INSERT INTO schema_migrations(filename,checksum) VALUES ($1,$2)',[file.filename,hashes.get(file.filename)]);
      await c.query('COMMIT');log('Applied '+file.filename);
    }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
  }
}
