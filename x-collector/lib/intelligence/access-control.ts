export type IntelligenceRole = 'admin' | 'analyst' | 'viewer';

export interface AccessContext {
  userId: string;
  role: IntelligenceRole;
}

export function canAccessIntelligence(role: IntelligenceRole, required: IntelligenceRole): boolean {
  const rank: Record<IntelligenceRole, number> = { viewer: 1, analyst: 2, admin: 3 };
  return rank[role] >= rank[required];
}
