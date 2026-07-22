import {
  BillingPeriod,
  NotificationType,
  PaymentCurrency,
  PaymentStatus,
  SubscriptionStatus,
  SubscriptionTier
} from "@prisma/client";
import { nanoid } from "nanoid";
import { addBillingPeriod } from "@solsub/shared";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { buildSolanaPayUrl, verifySolanaPayment } from "./solana.service";
import { sendTelegramMessage } from "./telegram.service";
import { AppError, assertFound } from "../utils/errors";

export async function initiatePayment(input: {
  userId: string;
  planId: SubscriptionTier;
  period: BillingPeriod;
  currency: PaymentCurrency;
}) {
  const plan = assertFound(
    await prisma.subscriptionPlan.findUnique({ where: { id: input.planId } }),
    "Plan not found"
  );
  if (!plan.isActive) {
    throw new AppError(400, "Plan is not active", "PLAN_INACTIVE");
  }

  const amountSol = Number(input.period === BillingPeriod.YEARLY ? plan.yearlySol : plan.monthlySol);
  const expectedAmount = input.currency === PaymentCurrency.SOL ? amountSol : await quoteUsdcAmount(amountSol);
  const nonce = `solsub-${nanoid(20)}`;
  const paymentUrl = buildSolanaPayUrl({
    recipient: env.TREASURY_WALLET,
    amount: expectedAmount,
    currency: input.currency,
    memo: nonce,
    label: env.APP_NAME,
    message: `${plan.name} ${input.period.toLowerCase()} subscription`
  });

  const expiresAt = new Date(Date.now() + 1000 * 60 * 30);
  const payment = await prisma.paymentTransaction.create({
    data: {
      userId: input.userId,
      planId: input.planId,
      period: input.period,
      currency: input.currency,
      expectedAmount,
      nonce,
      paymentUrl,
      expiresAt
    },
    include: { plan: true }
  });

  return payment;
}

export async function confirmPayment(userId: string, paymentId: string, signature: string) {
  const payment = assertFound(
    await prisma.paymentTransaction.findFirst({
      where: { id: paymentId, userId },
      include: { user: true, plan: true }
    }),
    "Payment not found"
  );

  if (payment.status === PaymentStatus.CONFIRMED) {
    return payment;
  }
  if (payment.status !== PaymentStatus.PENDING || payment.expiresAt < new Date()) {
    throw new AppError(400, "Payment is not payable anymore", "PAYMENT_NOT_PAYABLE");
  }

  await verifySolanaPayment({
    signature,
    nonce: payment.nonce,
    expectedAmount: Number(payment.expectedAmount),
    currency: payment.currency
  });

  const now = new Date();
  const endsAt = addBillingPeriod(now, payment.period);
  const updated = await prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.upsert({
      where: { id: payment.subscriptionId ?? "__missing__" },
      update: {
        planId: payment.planId,
        period: payment.period,
        status: SubscriptionStatus.ACTIVE,
        startsAt: now,
        endsAt,
        reminderSentAt: null
      },
      create: {
        userId,
        planId: payment.planId,
        period: payment.period,
        status: SubscriptionStatus.ACTIVE,
        startsAt: now,
        endsAt
      }
    });

    return tx.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.CONFIRMED,
        signature,
        confirmedAt: now,
        subscriptionId: subscription.id
      },
      include: { plan: true, user: true, subscription: true }
    });
  });

  await sendTelegramMessage(
    updated.user,
    `Payment confirmed. Your ${updated.plan.name} subscription is active until ${endsAt.toISOString().slice(0, 10)}.`,
    NotificationType.PAYMENT_CONFIRMED
  );

  return updated;
}

export async function getSubscriptionStatus(userId: string) {
  const subscription = await prisma.subscription.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { plan: true }
  });
  return subscription;
}

async function quoteUsdcAmount(amountSol: number) {
  // Production deployments should replace this deterministic demo quote with a price oracle.
  const demoSolUsd = 150;
  return Number((amountSol * demoSolUsd).toFixed(6));
}
