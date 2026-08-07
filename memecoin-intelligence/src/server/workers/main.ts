import { analysisWorker } from './analysisWorker.js';
import { telegramAiWorker } from './telegramAiWorker.js';
import { pool } from '@/server/db/pool.js';

async function shutdown() {
  await Promise.all([analysisWorker.close(), telegramAiWorker.close()]);
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('Memecoin Intelligence workers are running');
