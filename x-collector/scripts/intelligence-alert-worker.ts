import { processAlerts } from '../lib/intelligence/alert-engine';

export async function startAlertWorker(intervalMs = 5 * 60 * 1000) {
  await processAlerts();

  return setInterval(async () => {
    await processAlerts();
  }, intervalMs);
}
