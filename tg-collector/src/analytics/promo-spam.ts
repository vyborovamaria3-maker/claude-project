/** Narrow, high-confidence filter for repeated commercial milestone alerts.
 * This does NOT classify a token or its channel as spam: only this specific
 * promotional post format. Keep the original tg_messages row as audit history.
 */
export const PROMOTIONAL_MILESTONE = "promotional_milestone" as const;

export function promotionalMilestoneKind(text: string): typeof PROMOTIONAL_MILESTONE | null {
  if (text.length > 16_384) return null; // avoid scanning huge adversarial payloads
  const tag = /(?:^|[^\p{L}\p{N}_])[#$][A-Za-z][A-Za-z0-9]{1,9}\b/u.test(text);
  const vip = /\bVIP\s*[:：]\s*x\s*\d+(?:[.,]\d+)?\b/i.test(text);
  const growth = /\bGrowth\s*[:：]\s*x\s*\d+(?:[.,]\d+)?\b/i.test(text);
  const promotion = /\bDEX\s+PAID\b|\bGet\s+VIP\s+access\b/i.test(text);
  const milestone = /\bMC\s*[:：]|(?:\$\s*\d[\d.,]*\s*[KMB]?\s*(?:→|->)\s*\$\s*\d)/i.test(text);
  return tag && vip && growth && promotion && milestone ? PROMOTIONAL_MILESTONE : null;
}
