import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { generateSolanaPayUrl } from '../services/solana';
import {
  getOrCreateUser,
  getUserByTelegramId,
  createPayment,
  hasActiveSubscription,
} from '../services/db';
import { TelegramAuthError, verifyTelegramInitData } from '../security/telegram';

const createPaymentSchema = z.object({
  initData: z.string().min(1),
  plan: z.enum(['premium']).default('premium'),
});

function sendAuthError(res: Response) {
  return res.status(401).json({
    success: false,
    error: 'Invalid Telegram session',
  });
}

/**
 * POST /api/subscription/create
 * Create new payment for the authenticated Telegram user and return Solana Pay URL.
 */
export async function createPaymentHandler(req: Request, res: Response) {
  try {
    const { initData, plan } = createPaymentSchema.parse(req.body);
    const telegramUser = verifyTelegramInitData(initData);
    const tgId = BigInt(telegramUser.id);

    const user = await getOrCreateUser(tgId, telegramUser.username);

    // Unpredictable memo prevents user-id leakage and makes payment references non-guessable.
    const memo = `sub_${crypto.randomBytes(24).toString('hex')}`;

    // Fixed legacy price: 1000 USDT.
    const amount = 1000;
    const payment = await createPayment(user.id, amount, memo, plan);
    const payUrl = generateSolanaPayUrl(config.merchantWallet, amount, memo);

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      success: true,
      payUrl,
      paymentId: payment.id,
      memo,
      amount,
    });
  } catch (error) {
    console.error('Create payment error:', error);
    if (error instanceof TelegramAuthError) {
      return sendAuthError(res);
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors,
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to create payment',
    });
  }
}

/**
 * GET /api/subscription/status
 * Check subscription status for the authenticated Telegram user only.
 */
export async function getSubscriptionStatus(req: Request, res: Response) {
  try {
    const initData = req.header('x-telegram-init-data') || '';
    const telegramUser = verifyTelegramInitData(initData);
    const tgId = BigInt(telegramUser.id);

    const [user, active] = await Promise.all([
      getUserByTelegramId(tgId),
      hasActiveSubscription(tgId),
    ]);

    res.setHeader('Cache-Control', 'no-store');
    if (!user) {
      return res.json({
        success: true,
        active: false,
        subscriptionEnd: null,
        userExists: false,
      });
    }

    return res.json({
      success: true,
      active,
      subscriptionEnd: user.subscriptionEnd,
      userExists: true,
      telegramId: user.telegramId.toString(),
      username: user.username,
    });
  } catch (error) {
    console.error('Get status error:', error);
    if (error instanceof TelegramAuthError) {
      return sendAuthError(res);
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to get status',
    });
  }
}
