import { Worker } from 'bullmq';
import { env } from '@/server/config/env.js';
import { searchMentions } from '@/server/services/analysisService.js';
import { ingestMentions } from '@/server/services/ingestionService.js';
import { pool } from '@/server/db/pool.js';
import { queueConnection } from './queues.js';

export const analysisWorker = new Worker('analysis', async (job) => {
  const { runId, address, symbol, persist = true } = job.data as { runId: string; address: string; symbol?: string; persist?: boolean };
  await pool.query(`UPDATE analysis_runs SET status='running',started_at=now() WHERE id=$1`, [runId]);
  try {
    const result = await searchMentions({ address, symbol }, { bypassCache: true, includeRaw: persist });
    if (result.status === 'error') throw new Error(result.message);
    if (persist && result.status === 'ok' && result.rawMentions) await ingestMentions(result.rawMentions);
    const stored = result.status === 'ok' ? { ...result, rawMentions: undefined } : result;
    await pool.query(`UPDATE analysis_runs SET status='completed',metrics=$2,completed_at=now() WHERE id=$1`, [runId, stored]);
    return stored;
  } catch (error) {
    await pool.query(`UPDATE analysis_runs SET status='failed',error=$2,completed_at=now() WHERE id=$1`, [runId, error instanceof Error ? error.message : 'Unknown error']);
    throw error;
  }
}, { connection: queueConnection, concurrency: env.WORKER_CONCURRENCY, lockDuration: 120_000 });

analysisWorker.on('failed', (job, error) => {
  console.error(JSON.stringify({
    event: 'analysis-job-failed',
    jobId: job?.id,
    error: error.message,
    timestamp: new Date().toISOString()
  }));
});
