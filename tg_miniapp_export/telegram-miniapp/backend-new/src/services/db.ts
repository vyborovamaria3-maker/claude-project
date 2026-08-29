import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export { prisma };

// User operations
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

export async function updateSubscription(userId: string, days: number) {
  const currentEnd = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionEnd: true },
  });
  
  const now = new Date();
  const baseDate = currentEnd?.subscriptionEnd && currentEnd.subscriptionEnd > now
    ? currentEnd.subscriptionEnd
    : now;
  
  const newEnd = new Date(baseDate);
  newEnd.setDate(newEnd.getDate() + days);
  
  return prisma.user.update({
    where: { id: userId },
    data: { subscriptionEnd: newEnd },
  });
}

// Payment operations
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

export async function getPaymentBySignature(signature: string) {
  return prisma.payment.findUnique({
    where: { txSignature: signature },
  });
}

export async function confirmPayment(
  paymentId: string,
  signature: string
) {
  return prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'confirmed',
      txSignature: signature,
      confirmedAt: new Date(),
    },
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
