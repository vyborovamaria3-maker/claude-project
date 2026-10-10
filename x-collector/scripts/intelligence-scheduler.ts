import { runScheduledAnalysis } from '../lib/intelligence/scheduled-analysis';

export async function startIntelligenceScheduler(intervalMs = 60 * 60 * 1000) {
  await runScheduledAnalysis();

  return setInterval(async () => {
    await runScheduledAnalysis();
  }, intervalMs);
}
