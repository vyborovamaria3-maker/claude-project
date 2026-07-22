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

const createPaymentSchema = z.object({
  telegramId: z.string().or(z.number()),
  username: z.string().optional(),
  plan: z.enum(['premium']).default('premium'),
});

const getStatusSchema = z.object({
  userId: z.string().or(z.number()),
});

/**
 * POST /api/subscription/create
 * Create new payment and return Solana Pay URL
 */
export async function createPaymentHandler(req: Request, res: Response) {
  try {
    const { telegramId, username, plan } = createPaymentSchema.parse(req.body);
    
    const tgId = BigInt(telegramId);
    
    // Get or create user
    const user = await getOrCreateUser(tgId, username);
    
    // Generate unique memo
    const memo = `${telegramId}_${Date.now()}`;
    
    // Fixed price: 1000 USDT
    const amount = 1000;
    
    // Create payment record
    const payment = await createPayment(user.id, amount, memo, plan);
    
    // Generate Solana Pay URL
    const payUrl = generateSolanaPayUrl(
      config.merchantWallet,
      amount,
      memo
    );
    
    res.json({
      success: true,
      payUrl,
      paymentId: payment.id,
      memo,
      amount,
    });
  } catch (error) {
    console.error('Create payment error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: error.errors,
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to create payment',
    });
  }
}

/**
 * GET /api/subscription/status
 * Check subscription status for user
 */
export async function getSubscriptionStatus(req: Request, res: Response) {
  try {
    const { userId } = getStatusSchema.parse({ userId: req.query.userId });
    
    const tgId = BigInt(userId);
    
    const [user, active] = await Promise.all([
      getUserByTelegramId(tgId),
      hasActiveSubscription(tgId),
    ]);
    
    if (!user) {
      return res.json({
        success: true,
        active: false,
        subscriptionEnd: null,
        userExists: false,
      });
    }
    
    res.json({
      success: true,
      active,
      subscriptionEnd: user.subscriptionEnd,
      userExists: true,
      telegramId: user.telegramId.toString(),
      username: user.username,
    });
  } catch (error) {
    console.error('Get status error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Invalid userId',
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to get status',
    });
  }
}
