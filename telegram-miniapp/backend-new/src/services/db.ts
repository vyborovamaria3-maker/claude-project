import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export { prisma };

export async function getOrCreateUser(telegramId: bigint, username?: string) {
  const user = await prisma.user.findUnique({
    where: { telegramId },
  });

  if (user) return user;

  return prisma.user.create({
    data: {
      telegramId,
      username: username || null,
    },
  });
}

export async function getUserByTelegramId(telegramId: bigint) {
  return prisma.user.findUnique({
    where: { telegramId },
    include: { payments: true },
  });
}

export async function createPayment(
  userId: string,
  amount: number,
  memo: string,
  plan: string = 'premium'
) {
  return prisma.payment.create({
    data: {
      userId,
      amount,
      memo,
      plan,
      status: 'pending',
    },
  });
}

export async function getPaymentByMemo(memo: string) {
  return prisma.payment.findUnique({
    where: { memo },
    include: { user: true },
  });
}

/**
 * Atomically claim a pending payment and extend the user's entitlement once.
 * Returns false when another worker/webhook delivery already processed the payment.
 */
export async function confirmPaymentAndExtendSubscription(
  paymentId: string,
  signature: string,
  days: number
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, userId: true, status: true },
    });
    if (!payment || payment.status !== 'pending') {
      return false;
    }

    const claim = await tx.payment.updateMany({
      where: { id: paymentId, status: 'pending' },
      data: {
        status: 'confirmed',
        txSignature: signature,
        confirmedAt: new Date(),
      },
    });
    if (claim.count !== 1) {
      return false;
    }

    const user = await tx.user.findUnique({
      where: { id: payment.userId },
      select: { subscriptionEnd: true },
    });
    if (!user) {
      throw new Error('Payment user not found');
    }

    const now = new Date();
    const baseDate = user.subscriptionEnd && user.subscriptionEnd > now
      ? user.subscriptionEnd
      : now;
    const newEnd = new Date(baseDate);
    newEnd.setDate(newEnd.getDate() + days);

    await tx.user.update({
      where: { id: payment.userId },
      data: { subscriptionEnd: newEnd },
    });

    return true;
  });
}

export async function getPendingPaymentByUser(userId: string) {
  return prisma.payment.findFirst({
    where: {
      userId,
      status: 'pending',
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function hasActiveSubscription(telegramId: bigint): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { subscriptionEnd: true },
  });

  if (!user?.subscriptionEnd) return false;
  return user.subscriptionEnd > new Date();
}
