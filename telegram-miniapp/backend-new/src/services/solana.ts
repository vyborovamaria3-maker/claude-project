import fetch from 'node-fetch';
import { config } from '../config';

/**
 * Generate Solana Pay deep link for USDT transfer.
 * Format: solana:<recipient>?amount=<amount>&spl-token=<mint>&memo=<memo>
 */
export function generateSolanaPayUrl(
  recipient: string,
  amount: number,
  memo: string
): string {
  const url = new URL('solana:' + recipient);
  url.searchParams.append('amount', amount.toString());
  url.searchParams.append('spl-token', config.usdtMint);
  url.searchParams.append('label', 'Premium Subscription');
  url.searchParams.append('message', 'Payment for premium subscription');
  url.searchParams.append('memo', memo);
  return url.toString();
}

/** Validate Solana transaction signature format (Base58, 87-88 chars). */
export function isValidSignature(signature: string): boolean {
  return /^[A-HJ-NP-Za-km-z1-9]{87,88}$/.test(signature);
}

type TokenBalance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
  };
};

type RpcTransaction = {
  meta?: {
    err?: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    logMessages?: string[] | null;
  } | null;
  transaction?: {
    message?: {
      instructions?: unknown[];
    };
  };
};

type RpcResponse = {
  error?: unknown;
  result?: RpcTransaction | null;
};

function balanceSum(balances: TokenBalance[] | undefined): {
  raw: bigint;
  decimals: number | null;
} {
  let raw = 0n;
  let decimals: number | null = null;

  for (const balance of balances ?? []) {
    if (balance.mint !== config.usdtMint || balance.owner !== config.merchantWallet) {
      continue;
    }

    const amount = balance.uiTokenAmount?.amount;
    const currentDecimals = balance.uiTokenAmount?.decimals;
    if (
      !amount ||
      !/^\d+$/.test(amount) ||
      typeof currentDecimals !== 'number' ||
      !Number.isInteger(currentDecimals)
    ) {
      continue;
    }
    if (decimals !== null && decimals !== currentDecimals) {
      throw new Error('Inconsistent token decimals in Solana transaction');
    }

    decimals = currentDecimals;
    raw += BigInt(amount);
  }

  return { raw, decimals };
}

function decimalAmountToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Invalid expected token amount');
  }

  const fixed = amount.toFixed(decimals);
  const [whole, fraction = ''] = fixed.split('.');
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}

/**
 * Independently verify a Helius-reported payment against finalized Solana RPC data.
 */
export async function verifyFinalizedUsdtPayment(
  signature: string,
  memo: string,
  expectedAmount: number
): Promise<boolean> {
  if (!isValidSignature(signature) || !/^sub_[0-9a-f]{48}$/i.test(memo)) {
    return false;
  }

  const response = await fetch(config.solanaRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        signature,
        {
          encoding: 'jsonParsed',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Solana RPC returned HTTP ${response.status}`);
  }

  const payload = await response.json() as RpcResponse;
  const tx = payload.result;
  if (payload.error || !tx || !tx.meta || tx.meta.err) {
    return false;
  }

  if (!JSON.stringify(tx).includes(memo)) {
    return false;
  }

  const pre = balanceSum(tx.meta.preTokenBalances);
  const post = balanceSum(tx.meta.postTokenBalances);
  const decimals = post.decimals ?? pre.decimals;
  if (decimals === null) {
    return false;
  }

  const expectedRaw = decimalAmountToRaw(expectedAmount, decimals);
  return post.raw - pre.raw === expectedRaw;
}
