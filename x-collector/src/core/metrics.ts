export const metrics = {
  startedAt: Date.now(),
  tasksProcessed: 0,
  tasksFailed: 0,
  tweetsCollected: 0,
  accountsUsed: 0,
  xSearches: 0,
  collectorErrors: 0,
  entitiesExtracted: 0,
  entityErrors: 0,
  analyticsRuns: 0,
  reportsGenerated: 0,
  signalsCalculated: 0,
  signalsCreated: 0,
  signalsErrors: 0,
  weightedSignalsCalculated: 0,
  prioritySignalsCreated: 0,
  graphNodesBuilt: 0,
  graphEdgesBuilt: 0,
  relationshipsCalculated: 0,
  authorsAnalyzed: 0,
  kolsDetected: 0,
};

export function uptime() {
  return Date.now() - metrics.startedAt;
}
