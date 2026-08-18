import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { config } from '../config';
import { isValidSignature, verifyFinalizedUsdtPayment } from '../services/solana';
import {
  getPaymentByMemo,
  confirmPaymentAndExtendSubscription,
} from '../services/db';

interface TokenTransfer {
  mint: string;
  toUserAccount: string;
  fromUserAccount: string;
  tokenAmount: number;
}

interface HeliusTransaction {
  signature: string;
  type: string;
  memo?: string;
  tokenTransfers?: TokenTransfer[];
}

function secureEqual(received: string | undefined, expected: string) {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function handleHeliusWebhook(req: Request, res: Response) {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
    const rawToken = authHeader && !/^Bearer\s+/i.test(authHeader) ? authHeader : undefined;
    if (!secureEqual(bearerToken || rawToken, config.heliusWebhookSecret)) {
      console.warn('Invalid webhook secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const transactions: HeliusTransaction[] = Array.isArray(req.body)
      ? req.body
      : [req.body];
    if (transactions.length === 0 || transactions.length > 100) {
      return res.status(400).json({ error: 'Invalid webhook batch size' });
    }

    for (const tx of transactions) {
      await processTransaction(tx);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    return res.sendStatus(500);
  }
}

async function processTransaction(tx: HeliusTransaction) {
  if (!tx || typeof tx.signature !== 'string' || !isValidSignature(tx.signature)) {
    return;
  }
  if (!tx.memo || !/^sub_[0-9a-f]{48}$/i.test(tx.memo)) {
    return;
  }

  const usdtTransfer = tx.tokenTransfers?.find(
    (transfer) =>
      transfer.mint === config.usdtMint &&
      transfer.toUserAccount === config.merchantWallet
  );
  if (!usdtTransfer || !Number.isFinite(usdtTransfer.tokenAmount) || usdtTransfer.tokenAmount <= 0) {
    return;
  }

  const payment = await getPaymentByMemo(tx.memo);
  if (!payment || payment.status !== 'pending') {
    return;
  }
  if (Math.abs(usdtTransfer.tokenAmount - payment.amount) > 0.01) {
    return;
  }

  const onChainVerified = await verifyFinalizedUsdtPayment(
    tx.signature,
    tx.memo,
    payment.amount
  );
  if (!onChainVerified) {
    return;
  }

  await confirmPaymentAndExtendSubscription(payment.id, tx.signature, 365);
}

export function webhookHealth(req: Request, res: Response) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    merchantWallet: config.merchantWallet.slice(0, 8) + '...',
    usdtMint: config.usdtMint.slice(0, 8) + '...',
  });
}
