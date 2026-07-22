import { config } from '../config';

/**
 * Generate Solana Pay deep link for USDT transfer
 * Format: solana:<recipient>?amount=<amount>&spl-token=<mint>&memo=<memo>
 */
export function generateSolanaPayUrl(
  recipient: string,
  amount: number,
  memo: string
): string {
  // Build Solana Pay URL
  const url = new URL('solana:' + recipient);
  url.searchParams.append('amount', amount.toString());
  url.searchParams.append('spl-token', config.usdtMint);
  url.searchParams.append('label', 'Premium Subscription');
  url.searchParams.append('message', 'Payment for premium subscription');
  url.searchParams.append('memo', memo);
  
  return url.toString();
}

/**
 * Validate Solana transaction signature format (Base58, 87-88 chars)
 */
export function isValidSignature(signature: string): boolean {
  return /^[A-HJ-NP-Za-km-z1-9]{87,88}$/.test(signature);
}

/**
 * Parse memo to extract telegramId and timestamp
 */
export function parseMemo(memo: string): { telegramId: string; timestamp: number } | null {
  const parts = memo.split('_');
  if (parts.length !== 2) return null;
  
  const telegramId = parts[0];
  const timestamp = parseInt(parts[1], 10);
  
  if (!telegramId || isNaN(timestamp)) return null;
  
  return { telegramId, timestamp };
}
