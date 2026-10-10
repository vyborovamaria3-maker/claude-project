export type AnalysisJob = {
  name: string;
  intervalMinutes: number;
};

export const scheduledAnalyses: AnalysisJob[] = [
  { name: 'refresh_scores', intervalMinutes: 60 },
  { name: 'discover_relations', intervalMinutes: 120 },
  { name: 'analyze_risk', intervalMinutes: 180 },
];

export function getScheduledAnalyses() {
  return scheduledAnalyses;
}

export type ScheduledAnalysisRun = AnalysisJob & { startedAt: string };

export async function runScheduledAnalysis(jobs: AnalysisJob[] = scheduledAnalyses): Promise<ScheduledAnalysisRun[]> {
  const startedAt = new Date().toISOString();
  return jobs.map((job) => ({ ...job, startedAt }));
}
