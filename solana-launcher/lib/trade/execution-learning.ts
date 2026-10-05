export type TradeOutcome = {
  ts: number;
  mint: string;
  pnlSol: number;
  pnlPct?: number | null;
  decisionSource?: "agent" | "system" | string;
  decisionAction?: string;
  reason?: string;
  lesson?: string | null;
  selfCritique?: string | null;
  tags?: string[];
};

export type EvolvedRule = {
  key: string;
  text: string;
  hits: number;
  lastOutcomeTs: number;
};

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function canonicalizeLesson(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[1-9a-hj-np-z]{32,44}/gi, "<mint>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:sol|usd|bps|%|pct|seconds?|secs?|ms|mins?|minutes?)\b/gi, "<num>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<num>")
    .replace(/[^a-z0-9а-яё<>\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

export function promoteRepeatedLessons(
  outcomes: TradeOutcome[],
  { minRepeats = 3, maxRules = 6 }: { minRepeats?: number; maxRules?: number } = {},
): EvolvedRule[] {
  const grouped = new Map<string, { count: number; exemplar: string; lastTs: number }>();
  for (const outcome of outcomes || []) {
    const lesson = String(outcome?.lesson || "").trim();
    if (!lesson) continue;
    const key = canonicalizeLesson(lesson);
    if (!key) continue;
    const previous = grouped.get(key);
    grouped.set(key, {
      count: (previous?.count || 0) + 1,
      exemplar: previous?.exemplar || lesson.replace(/\s+/g, " ").trim().slice(0, 180),
      lastTs: Math.max(previous?.lastTs || 0, finite(outcome.ts)),
    });
  }

  return [...grouped.entries()]
    .filter(([, group]) => group.count >= Math.max(2, minRepeats))
    .sort((a, b) => b[1].count - a[1].count || b[1].lastTs - a[1].lastTs)
    .slice(0, Math.max(1, maxRules))
    .map(([key, group]) => ({ key, text: group.exemplar, hits: group.count, lastOutcomeTs: group.lastTs }));
}

export function summarizeTradeOutcomes(outcomes: TradeOutcome[], window = 30) {
  const take = (outcomes || []).slice(0, Math.max(1, Math.min(200, window)));
  if (!take.length) {
    return { n: 0, winRate: null, avgPnlSol: null, bestPnlSol: null, worstPnlSol: null, pendingCritiques: [] as TradeOutcome[] };
  }
  const pnls = take.map((item) => finite(item.pnlSol));
  const wins = pnls.filter((value) => value > 0).length;
  const pendingCritiques = take.filter((item) => item.decisionSource === "agent" && finite(item.pnlSol) < 0 && !String(item.selfCritique || "").trim());
  return {
    n: take.length,
    winRate: wins / take.length,
    avgPnlSol: pnls.reduce((sum, value) => sum + value, 0) / take.length,
    bestPnlSol: Math.max(...pnls),
    worstPnlSol: Math.min(...pnls),
    pendingCritiques,
  };
}
