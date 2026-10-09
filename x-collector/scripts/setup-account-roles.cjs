// Standalone migration: does not collide with the user's numbered migrations.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {Client}=require(path.join(root,'node_modules/pg'));
const dotenv=require(path.join(root,'node_modules/dotenv'));
const env=dotenv.parse(fs.readFileSync(process.env.X_COLLECTOR_ENV || path.join(root,'.env')));
if(!env.DATABASE_URL)throw Error('DATABASE_URL is missing in x-collector/.env');
const source=path.join(root,'lib/trade/account-manager.ts');
const original=fs.readFileSync(source,'utf8');
const pattern=/WHERE status\s*=\s*'active' AND tier\s*!=\s*'retired'/g;
let updated=original;
if(!/WHERE role\s*=\s*'collector' AND status\s*=\s*'active'/.test(original)) {
 const matches=original.match(pattern)||[];
 if(matches.length!==1)throw Error('Unknown account-manager.ts format. No database changes made. Send this file for review.');
 updated=original.replace(pattern,"WHERE role='collector' AND status='active' AND tier != 'retired'");
}
(async()=>{
 const client=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000});
 try {
  await client.connect();await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("ALTER TABLE x_accounts ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'collector'");
  await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='x_accounts'::regclass AND conname='xc_account_role_check') THEN ALTER TABLE x_accounts ADD CONSTRAINT xc_account_role_check CHECK (role IN ('collector','publisher')); END IF; END $$");
  await client.query("CREATE INDEX IF NOT EXISTS idx_x_accounts_role ON x_accounts(role,status)");
  if(updated!==original){fs.copyFileSync(source,source+'.backup-'+Date.now());fs.writeFileSync(source,updated);}
  await client.query('COMMIT');
  console.log('Account roles installed. Existing accounts: collector. Run npm.cmd run build before restarting worker.');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(updated!==original)fs.writeFileSync(source,original);console.error('Setup failed:',error.message);process.exitCode=1;}
 finally{await client.end().catch(()=>{});}
})();
