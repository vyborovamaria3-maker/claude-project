export type AiMessageContext = Readonly<{evidenceRef:string;text:string;postedAt:string;observedAt:string}>;

/** Conservative format filter, not a claim that every promotional author is a bot. */
export function isLowValueTelegramPost(text:string):boolean {
  if(/^[\p{Extended_Pictographic}\uFE0F\s]*(?:Gamble Found!|token (?:started migration|migration completed)|Alpha One (?:Alert|Ai Agent)|New Signal from Alpha|Achievement Unlocked)/iu.test(text))return true;
  if(/^\s*[🔥🎉].*\$[^\n]+(?:>>|[Хx]\d|\d+(?:\.\d+)?x\s*\()/iu.test(text))return true;
  if(/^(?:https?:\/\/\S+\s*)+$/.test(text.trim())||/^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(text.trim()))return true;
  // Require the complete repeated card shape; words such as VIP or NOT alone are not spam.
  if(/^x\d+(?:\.\d+)? from VIP [·|]/i.test(text.trim())&&/[├└│]/.test(text)&&/DEX (?:NOT )?PAID|CA:/i.test(text))return true;
  if(/^#[^\s]+\s*[·|]\s*VIP:\s*x\d/i.test(text.trim())&&/[├└│]/.test(text)&&/Growth:|Get VIP access/i.test(text))return true;
  if(/^[\p{Extended_Pictographic}\uFE0F\s]*VERIFIED AXIOSCAN\b/iu.test(text)&&/#RESULTS|HIT RATE/i.test(text))return true;
  if(/^[⭐️\s]*VIP access:\s*@\w+[⭐️\s]*$/iu.test(text))return true;
  if(/^Track the flights of the fastest and most powerful rockets here:/i.test(text)&&/@\w+_bot/.test(text)&&/\/subscribe/.test(text)&&/All Access.*Profit!/i.test(text)&&text.length<250)return true;
  // Full scanner layout only: preserve commentary before/after a quoted card.
  if(/^[^\n]{1,100}\r?\n[1-9A-HJ-NP-Za-km-z]{32,44}\s*\n/.test(text)&&
    /\bby MonstaScan\b/i.test(text)&&/^Cap:/m.test(text)&&/^Vol:/m.test(text)&&
    /^Bonding Curve:/m.test(text)&&/^Top 10 in detail\s*$/m.test(text)&&
    /Copyright[^\n]*pf_ultimate\s*$/i.test(text))return true;
  const fields=new Set([...text.matchAll(/\b(MC|VOL|HOLDERS|deployer stats|Mint|Freeze|Market Cap|Liquidity|Token Age|Top 10|Dev Wallet|CA|Token Contract|Entry MC|ATH MC|ROI)\s*[:|]/gi)].map(m=>m[1]!.toLowerCase()));
  return fields.size>=3&&/[├└│]|Automated by|Chart:|VIP|BOT/i.test(text);
}
