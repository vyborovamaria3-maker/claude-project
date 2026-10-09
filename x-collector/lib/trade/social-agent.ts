import { z } from "zod";
export interface AgentCandidate {
  tweetId: string; handle: string; text: string; postedAt: number;
  mints: string[]; influence: number; engagement: number;
}
export interface AgentContext { candidates: AgentCandidate[]; maxActions: number; signal: AbortSignal }
export interface AgentProvider { name: string; choose(context: AgentContext): Promise<unknown> }
const ChoiceSchema = z.array(z.object({
  tweetId: z.string().min(1),
  kind: z.enum(["post", "reply", "repost", "like", "follow"]),
  reason: z.string().min(1).max(500),
}).strict()).max(10);
export type AgentChoice = z.infer<typeof ChoiceSchema>[number];
export interface AgentDraft extends AgentChoice { status: "simulated" | "blocked"; content: string | null }

export function selectCandidates(rows: AgentCandidate[], now: number): AgentCandidate[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    if (seen.has(row.tweetId) || !row.handle || !Number.isFinite(row.postedAt) || row.postedAt > now || row.postedAt <= now - 86_400_000) return false;
    const tokenEvidence = row.mints.some(mint => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint));
    const topicEvidence = /\b(solana|pump\.fun|pumpfun|raydium|bonk)\b/i.test(row.text) && /\b(meme\s?coin|memecoin|meme\s?token|pump\.fun|pumpfun|bonk)\b/i.test(row.text);
    if (!tokenEvidence && !topicEvidence) return false;
    seen.add(row.tweetId); return true;
  }).sort((a,b) => Math.max(0,Math.min(100,b.influence)) - Math.max(0,Math.min(100,a.influence)) || b.postedAt-a.postedAt || a.tweetId.localeCompare(b.tweetId)).slice(0,100);
}

/** Provider output is a closed list of choices; it cannot execute tools or invent target IDs. */
export function validateChoices(output: unknown, candidates: AgentCandidate[], maxActions: number): AgentChoice[] {
  const choices = ChoiceSchema.parse(output);
  const ids = new Set(candidates.map(c => c.tweetId));
  const seen = new Set<string>();
  for (const choice of choices) {
    if (!ids.has(choice.tweetId)) throw new Error("Provider selected an unknown tweet");
    const key = `${choice.kind}:${choice.tweetId}`;
    if (seen.has(key)) throw new Error("Provider returned duplicate actions");
    seen.add(key);
  }
  if (choices.length > maxActions) throw new Error("Provider exceeded action budget");
  return choices;
}

export function prepareDraft(choice: AgentChoice, candidate: AgentCandidate): AgentDraft {
  const url = `https://x.com/i/status/${encodeURIComponent(candidate.tweetId)}`;
  // Use a trusted template rather than treating a source post as verified financial claims.
  const content = choice.kind === "post" ? `Обсуждение мемкоинов Solana. Источник для самостоятельной проверки: ${url}` : null;
  if (choice.kind === "like" || choice.kind === "follow") return { ...choice, status: "blocked", content, reason: "Автоматические лайки и проактивные подписки отключены; рекомендация сохранена." };
  if (choice.kind === "reply") return { ...choice, status: "blocked", content, reason: "ИИ-ответы не включены: нужны разрешение X и условия согласия получателя." };
  return { ...choice, status: "simulated", content };
}

/** Offline adapter for testing infrastructure; this is not an AI model. */
export const previewProvider: AgentProvider = {
  name: "deterministic-preview",
  async choose({ candidates, maxActions }) {
    return candidates.slice(0,maxActions).map(candidate => ({ tweetId: candidate.tweetId, kind: "post", reason: "Недавнее обсуждение Solana; приоритет по репутации автора и времени публикации." }));
  },
};
