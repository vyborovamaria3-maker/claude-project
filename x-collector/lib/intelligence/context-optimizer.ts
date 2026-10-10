export interface ContextEntry {
  key: string;
  value: unknown;
  priority?: number;
}

export function optimizeContext(entries: ContextEntry[], limit = 50): ContextEntry[] {
  return [...entries]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, limit);
}
