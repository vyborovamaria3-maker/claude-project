export type QualityCheckResult = {
  score: number;
  issues: string[];
};

export function validateEntityData(input: Record<string, unknown>): QualityCheckResult {
  const issues: string[] = [];

  if (!input.id) issues.push('missing_entity_id');
  if (!input.source) issues.push('missing_source');

  const score = Math.max(0, 1 - issues.length * 0.25);

  return { score, issues };
}
