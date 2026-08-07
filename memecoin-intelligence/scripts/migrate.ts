import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '@/server/db/pool.js';

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
for (const filename of (await readdir(resolve('db/migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
  const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
  if (exists.rowCount) continue;
  const sql = await readFile(resolve('db/migrations', filename), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
    await client.query('COMMIT');
    console.log(`Applied ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
await pool.end();
