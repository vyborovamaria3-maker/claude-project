import { Worker } from 'bullmq';
import { env } from '@/server/config/env.js';
import { queueConnection } from './queues.js';
import { completeTelegramAiRun, failTelegramAiRun, loadTelegramAiRun, markTelegramAiRunRunning } from '@/server/telegram-ai/repository.js';
import { runTelegramAi } from '@/server/telegram-ai/qwenClient.js';

export const telegramAiWorker = new Worker('telegram-ai', async (job) => {
  const { runId } = job.data as { runId: string };
  const claimed = await markTelegramAiRunRunning(runId);
  if (!claimed) return { runId, skipped: true };
  try {
    const input = await loadTelegramAiRun(runId);
    if (!input) throw new Error(`Telegram AI run not found: ${runId}`);
    const completion = await runTelegramAi(input.messages, input.context);
    await completeTelegramAiRun(runId, completion);
    return { runId, result: completion.result, latencyMs: completion.latencyMs };
  } catch (error) {
    try {
      await failTelegramAiRun(runId, error);
    } catch (persistError) {
      console.error(JSON.stringify({ event: 'telegram-ai-failure-persist-failed', runId, error: persistError instanceof Error ? persistError.message : String(persistError) }));
    }
    throw error;
  }
}, { connection: queueConnection, concurrency: env.TELEGRAM_AI_WORKER_CONCURRENCY, lockDuration: env.TELEGRAM_AI_TIMEOUT_MS + 30_000 });

telegramAiWorker.on('failed', (job, error) => {
  console.error(JSON.stringify({ event: 'telegram-ai-job-failed', jobId: job?.id, error: error.message }));
});
