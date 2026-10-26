export type AiMessageContext = Readonly<{evidenceRef:string;text:string;postedAt:string;observedAt:string}>;

/** Conservative format filter, not a claim that every promotional author is a bot. */
export function isLowValueTelegramPost(text:string):boolean {
  // Explicit human framing outside a quoted card must not disappear merely
  // because the quote contains scanner fields or begins with a bot heading.
  if(/^(?:I (?:do not|don't|would not|wouldn't|am not) (?:buy|trust)|Do not (?:buy|trust)|Don't (?:buy|trust)|This (?:card|scanner|claim) is (?:false|misleading)|Yeah right[,!]).+$/im.test(text))return false;
  if(/^\s*\$\S+\s+\d+(?:\.\d+)?x from called[^\n]*\n[\d.,]+[KM]?\s*➡️?\s*[\d.,]+[KM]? now\s*\n+Ads:[^\n]+\s*$/iu.test(text))return true;
  if(/^(?:[\p{Extended_Pictographic}\uFE0F\s]*\$\w+\s*·\s*Solana|\d+(?:\.\d+)?x\.|\$\w+ (?:just )?\d+(?:\.\d+)?x['’]d\.)/iu.test(text)&&
    /\n[\p{Extended_Pictographic}\uFE0F\s]*Chart & Trade:\s*https:\/\/gmgn\.ai\/[^\s]+\s*\n+Join the VIP Signal group\s*$/iu.test(text))return true;
  // Entire metric/affiliate card only; surrounding human criticism must survive.
  if(/^[^\n]{0,12}\$\w+\s*\|\s*MC:[^\n]+\r?\nVol:[^\n]+\|\s*Top 10:[^\n]+\|\s*Holders:[^\n]+\s*\n+[1-9A-HJ-NP-Za-km-z]{32,44}\s*\n+Safer & Quality -> Join Private\s*\n+[^\n]*Snip:[^\n]+\n+Check the CHART - Find ur entry, don't fomo\s*!+\s*\n+Ads:[^\n]+\s*$/iu.test(text))return true;
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

/** Recognize complete repeated call/ROI templates, not ordinary bullish discussion. */
export function isLowValueTwitterPost(text:string):boolean {
  // A complete call card is made only of known promotional lines. Any additional
  // discussion/denial breaks the shape, even when quoting one of these cards.
  const lines=text.replace(/\p{Extended_Pictographic}|\uFE0F/gu,'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const plain=lines.join('\n');
  if(/^(?:@\w+\s+)*(?:https?:\/\/\S+\s*)+$/u.test(plain))return true;
  if(/^\d+(?:\.\d+)?x up from my call on \$\w+\nCA(?:&gt;){2}\n[1-9A-HJ-NP-Za-km-z]{32,44}\n(?:#\w+\s*)+(?:https?:\/\/\S+\s*)*$/iu.test(plain))return true;
  if(/^(?:@\w+\s+)*(?:solana:)?[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(plain))return true;
  if(/^\$\w+ IS PRINTING!\nMy Alpha TG fam is catching massive moves!\s*Copy trading with us means staying in the game\.\nReady for the next alpha\?\nCA:\s*[1-9A-HJ-NP-Za-km-z]{32,44}\s+https?:\/\/\S+$/iu.test(plain)||
    /^Secured a massive move with \$\w+\nEntered at \$[\d.]+k, now sitting at \$[\d.]+k, marking an incredible [\d.]+x return!\nDon't miss the next one-catch these opportunities first in my private TG!\nCa:\s*[1-9A-HJ-NP-Za-km-z]{32,44}\n(?:#\w+\s*)+(?:https?:\/\/\S+\s*)*$/iu.test(plain))return true;
  if(lines.some(line=>/^(?:CA:|CA&gt;)/.test(line))&&
    lines.some(line=>/^(?:Found \$\w+ at just \$|\$\w+ - \d+(?:\.\d+)?X from entry|\$[\d.]+K\s*→|\$\w+ IS GOING PARABOLIC!)/i.test(line))&&
    lines.every(line=>/^(?:Found \$\w+ at just \$[\d.]+K|Ultra early, watching it closely|\$\w+ - \d+(?:\.\d+)?X from entry Nailed the early call, chart exploded|\$[\d.]+K\s*→\s*\$[\d.]+K MC = \d+(?:\.\d+)?x!?|My \$\w+ call\.|Called early\. Momentum followed\.|Keep watching — the next move could be bigger\.|\$\w+ IS GOING PARABOLIC!|My private TG squad keeps catching these monster moves!\s*Don’t sleep on the next alpha!|CA:\s*[1-9A-HJ-NP-Za-km-z]{32,44}(?:\s+https?:\/\/\S+)?|CA&gt;|[1-9A-HJ-NP-Za-km-z]{32,44}|(?:#\w+\s*)+(?:https?:\/\/\S+\s*)*)$/iu.test(line)))return true;
  return /^\s*\d+(?:\.\d+)?k to \$\w+[^\n]*\n+CA:\s*[1-9A-HJ-NP-Za-km-z]{32,44}\s*\n+Keeping an eye on this one\.[^\n]*\n+(?:#\w+\s*)+(?:https?:\/\/\S+\s*)*$/iu.test(text)||
    /^\s*\d+(?:\.\d+)?X[^\n]* from my \$\w+ call\.\s*\n+Called early\. Momentum went CRAZY\.[^\n]*\n+CA:\s*[1-9A-HJ-NP-Za-km-z]{32,44}\s*\n+(?:#\w+\s*)+(?:https?:\/\/\S+\s*)*$/iu.test(text);
}

/** Short-link tracking differences do not create independent social evidence. */
export function twitterEvidenceKey(text:string):string {
  const normalized=text.normalize('NFKC');
  // Without a literal token identity, different links can be different news or
  // evidence. Do not collapse those just because their captions are identical.
  const withIdentity=/(?:^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?=$|[^1-9A-HJ-NP-Za-km-z])|\b0x[a-fA-F0-9]{40}\b/u.test(normalized);
  return (withIdentity?normalized.replace(/https?:\/\/t\.co\/[^\s]+/gi,'[short-link]'):normalized).replace(/\s+/gu,' ').trim();
}
