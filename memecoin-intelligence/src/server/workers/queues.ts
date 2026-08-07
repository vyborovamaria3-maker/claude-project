import { Queue, type JobsOptions } from 'bullmq';
import { env } from '@/server/config/env.js';

const redisUrl = new URL(env.REDIS_URL);
export const queueConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: Number(redisUrl.pathname.replace('/', '') || 0),
  maxRetriesPerRequest: null,
  ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
};

const defaults: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: { age: 86_400, count: 10_000 },
};

export const ingestionQueue = new Queue('ingestion', { connection: queueConnection, defaultJobOptions: defaults });
export const featureQueue = new Queue('features', { connection: queueConnection, defaultJobOptions: defaults });
export const graphQueue = new Queue('graph', { connection: queueConnection, defaultJobOptions: defaults });
export const scoringQueue = new Queue('scoring', { connection: queueConnection, defaultJobOptions: defaults });
export const analysisQueue = new Queue('analysis', { connection: queueConnection, defaultJobOptions: defaults });
export const telegramAiQueue = new Queue('telegram-ai', { connection: queueConnection, defaultJobOptions: { ...defaults, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } } });

export async function closeQueues() {
  await Promise.all([ingestionQueue.close(), featureQueue.close(), graphQueue.close(), scoringQueue.close(), analysisQueue.close(), telegramAiQueue.close()]);
}
