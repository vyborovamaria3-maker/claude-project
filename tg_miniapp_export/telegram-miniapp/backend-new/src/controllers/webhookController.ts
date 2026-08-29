import { Request, Response } from 'express';
import { config } from '../config';
import { parseMemo } from '../services/solana';
import {
  getPaymentByMemo,
  confirmPayment,
  updateSubscription,
} from '../services/db';

// Helius webhook payload types
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

/**
 * POST /webhook/helius
 * Handle Helius webhook for transaction confirmations
 */
export async function handleHeliusWebhook(req: Request, res: Response) {
  try {
    // Verify webhook secret. Accept Bearer tokens and the legacy raw-token header.
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
    if (!authHeader || (authHeader !== config.heliusWebhookSecret && bearerToken !== config.heliusWebhookSecret)) {
      console.warn('Invalid webhook secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const transactions: HeliusTransaction[] = Array.isArray(req.body) 
      ? req.body 
      : [req.body];

    console.log(`Processing ${transactions.length} transactions from Helius`);

    for (const tx of transactions) {
      await processTransaction(tx);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    // Return 200 anyway to prevent Helius retries for invalid data
    res.sendStatus(200);
  }
}

async function processTransaction(tx: HeliusTransaction) {
  // Check if transaction has memo
  if (!tx.memo) {
    console.log('Transaction has no memo, skipping');
    return;
  }

  // Check for USDT transfer to merchant wallet
  const usdtTransfer = tx.tokenTransfers?.find(
    (t) => 
      t.mint === config.usdtMint &&
      t.toUserAccount === config.merchantWallet
  );

  if (!usdtTransfer) {
    console.log('No USDT transfer to merchant found, skipping');
    return;
  }

  console.log(`Found USDT transfer: ${tx.signature}`);
  console.log(`Amount: ${usdtTransfer.tokenAmount} USDT`);
  console.log(`Memo: ${tx.memo}`);

  // Parse memo to get telegramId
  const parsed = parseMemo(tx.memo);
  if (!parsed) {
    console.warn('Invalid memo format:', tx.memo);
    return;
  }

  // Find payment by memo
  const payment = await getPaymentByMemo(tx.memo);
  if (!payment) {
    console.warn('Payment not found for memo:', tx.memo);
    return;
  }

  if (payment.status === 'confirmed') {
    console.log('Payment already confirmed:', payment.id);
    return;
  }

  // Verify amount (allow small rounding differences)
  if (Math.abs(usdtTransfer.tokenAmount - payment.amount) > 0.01) {
    console.warn(`Amount mismatch: expected ${payment.amount}, got ${usdtTransfer.tokenAmount}`);
    return;
  }

  // Confirm payment and extend subscription
  await confirmPayment(payment.id, tx.signature);
  
  // Extend subscription for 365 days (1 year for 1000 USDT)
  await updateSubscription(payment.userId, 365);

  console.log(`✅ Payment confirmed: ${payment.id}`);
  console.log(`✅ Subscription extended for user: ${payment.userId}`);
}

/**
 * GET /webhook/helius/health
 * Health check endpoint for Helius webhook configuration
 */
export function webhookHealth(req: Request, res: Response) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    merchantWallet: config.merchantWallet.slice(0, 8) + '...',
    usdtMint: config.usdtMint.slice(0, 8) + '...',
  });
}
