export interface LearningExperience {
  entityId: string;
  decision: string;
  outcome: string;
  score: number;
  createdAt: number;
}

const experiences: LearningExperience[] = [];

export function recordExperience(experience: LearningExperience): LearningExperience {
  experiences.push(experience);
  return experience;
}

export function getExperiences(entityId?: string): LearningExperience[] {
  return entityId ? experiences.filter((item) => item.entityId === entityId) : [...experiences];
}

export function calculateLearningScore(entityId: string): number {
  const items = getExperiences(entityId);
  if (!items.length) return 0;
  return items.reduce((sum, item) => sum + item.score, 0) / items.length;
}
