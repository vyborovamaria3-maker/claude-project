const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {Client}=require(path.join(root,'node_modules/pg'));
const dotenv=require(path.join(root,'node_modules/dotenv'));
const env=dotenv.parse(fs.readFileSync(process.env.X_COLLECTOR_ENV||path.join(root,'.env')));
if(!env.DATABASE_URL)throw Error('DATABASE_URL missing in x-collector/.env');
(async()=>{const client=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000});try{
await client.connect();await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='10s'");
await client.query('ALTER TABLE x_accounts ADD COLUMN IF NOT EXISTS publisher_handle TEXT');
await client.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='x_accounts'::regclass AND conname='xc_publisher_handle_check') THEN ALTER TABLE x_accounts ADD CONSTRAINT xc_publisher_handle_check CHECK (publisher_handle IS NULL OR publisher_handle ~ '^[a-z0-9_]{1,15}$'); END IF; END $$");
await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_x_publisher_handle ON x_accounts(publisher_handle) WHERE role='publisher' AND publisher_handle IS NOT NULL");
await client.query("CREATE INDEX IF NOT EXISTS idx_tweets_author_stats ON twitter_tweets(lower(ltrim(handle,'@')),posted_at)");
await client.query('COMMIT');console.log('Publisher statistics schema installed.');
}catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('Setup failed:',error.message);process.exitCode=1;}finally{await client.end().catch(()=>{});}})();
