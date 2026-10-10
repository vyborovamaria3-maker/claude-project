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
