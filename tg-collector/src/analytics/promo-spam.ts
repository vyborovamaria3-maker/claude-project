/** Bounded source-level preflight: never infer that a channel is useless from
 * one token mention or from ordinary performance research.
 */
export const PROMOTIONAL_MILESTONE = "promotional_milestone" as const;
export const PROMO_SAMPLE_LIMIT = 120;
const TICKER = /(?:^|[^\p{L}\p{N}_])[#$]([A-Za-z][A-Za-z0-9]{1,9})\b/u;

export function promotionalMilestoneKind(text: string): typeof PROMOTIONAL_MILESTONE | null {
  if (text.length > 16_384) return null;
  const tag = TICKER.test(text);
  const vip = /\bVIP\s*[:：]\s*x\s*\d+(?:[.,]\d+)?\b/i.test(text);
  const growth = /\bGrowth\s*[:：]\s*x\s*\d+(?:[.,]\d+)?\b/i.test(text);
  const promotion = /\bDEX\s+PAID\b|\bGet\s+VIP\s+access\b/i.test(text);
  const milestone = /\bMC\s*[:：]|(?:\$\s*\d[\d.,]*\s*[KMB]?\s*(?:→|->)\s*\$\s*\d)/i.test(text);
  return tag && vip && growth && promotion && milestone ? PROMOTIONAL_MILESTONE : null;
}

export type PreviewPost = {id?:number;message?:string|null};
export type PromoAssessment = {
  inspected: number; matches: number; repeatedTicker: string|null;
  spam: boolean;
};
/** A high-confidence, repeated, same-token series: >=6 milestone ads,
 * >=10% of recent posts, >=5 posts naming one ticker. This catches the
 * 15 repeated #PNUT paid-VIP alerts without blocking a normal single call.
 * Only unique Telegram post IDs are counted if they are supplied.
 */
export function assessPromotionalChannel(posts: readonly PreviewPost[]): PromoAssessment {
  const seen=new Set<number>();
  const perTicker=new Map<string,number>();
  let inspected=0, matches=0;
  for(const post of posts.slice(0,PROMO_SAMPLE_LIMIT)){
    if(typeof post.id==="number"){
      if(seen.has(post.id))continue;
      seen.add(post.id);
    }
    inspected++;
    const text=typeof post.message==="string"?post.message:"";
    if(!promotionalMilestoneKind(text))continue;
    matches++;
    const ticker=TICKER.exec(text)?.[1]?.toUpperCase();
    if(ticker)perTicker.set(ticker,(perTicker.get(ticker)??0)+1);
  }
  const ordered=[...perTicker].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const repeatedTicker=(ordered[0]?.[1]??0)>=5?ordered[0][0]:null;
  return {inspected,matches,repeatedTicker,
    spam:inspected>=12 && matches>=6 && matches/inspected>=0.10 && repeatedTicker!==null};
}

/** Live threshold validation is an operator rollout step, never an implicit default. */
export function promotionalScreeningEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  return env.TG_PROMOTIONAL_SCREENING_ENABLED === "true";
}
