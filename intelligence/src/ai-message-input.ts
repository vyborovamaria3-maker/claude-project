export type AiMessageContext = Readonly<{evidenceRef:string;text:string;postedAt:string;observedAt:string}>;

/** Conservative format filter, not a claim that every promotional author is a bot. */
export function isLowValueTelegramPost(text:string):boolean {
  if(/^[\p{Extended_Pictographic}\uFE0F\s]*(?:Gamble Found!|token (?:started migration|migration completed)|Alpha One (?:Alert|Ai Agent)|New Signal from Alpha|Achievement Unlocked)/iu.test(text))return true;
  if(/^\s*[🔥🎉].*\$[^\n]+(?:>>|[Хx]\d|\d+(?:\.\d+)?x\s*\()/iu.test(text))return true;
  if(/^(?:https?:\/\/\S+\s*)+$/.test(text.trim())||/^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(text.trim()))return true;
  const fields=new Set([...text.matchAll(/\b(MC|VOL|HOLDERS|deployer stats|Mint|Freeze|Market Cap|Liquidity|Token Age|Top 10|Dev Wallet|CA|Token Contract|Entry MC|ATH MC|ROI)\s*[:|]/gi)].map(m=>m[1]!.toLowerCase()));
  return fields.size>=3&&/[├└│]|Automated by|Chart:|VIP|BOT/i.test(text);
}
