import { z } from 'zod';
import { pool } from '@/server/db/pool.js';
import { analysisQueue } from '@/server/workers/queues.js';
import { addressSchema } from './analysisService.js';
import { getProvider } from '@/server/providers/index.js';

export async function enqueueAnalysis(input: unknown) {
  const { address, symbol, persist } = z.object({
    address: addressSchema,
    symbol: z.string().trim().max(32).optional(),
    persist: z.boolean().default(true),
  }).parse(input);
  const provider = getProvider();
  const { rows } = await pool.query<{ id: string }>(`
    INSERT INTO analysis_runs(provider,status,query) VALUES($1,'queued',$2) RETURNING id`,
    [provider.name, { address, symbol, persist }]);
  const runId = rows[0]!.id;
  try {
    await analysisQueue.add('analyze-token', { runId, address, symbol, persist }, {
      jobId: `analysis:${address}:${Date.now()}`,
    });
  } catch (error) {
    // Do not leave a permanent `queued` row if Redis/BullMQ rejected the job.
    try {
      await pool.query(`UPDATE analysis_runs SET status='failed',error=$2,completed_at=now() WHERE id=$1`, [
        runId,
        error instanceof Error ? error.message : 'Failed to enqueue analysis job',
      ]);
    } catch {
      // Preserve the queue error: callers need to know the enqueue itself failed.
    }
    throw error;
  }
  return { runId, status: 'queued' as const };
}

export async function analysisJob(input: unknown) {
  const { runId } = z.object({ runId: z.string().uuid() }).parse(input);
  const { rows } = await pool.query(`SELECT id,status,provider,query,metrics,error,started_at,completed_at,created_at FROM analysis_runs WHERE id=$1`, [runId]);
  return rows[0] ?? null;
}
