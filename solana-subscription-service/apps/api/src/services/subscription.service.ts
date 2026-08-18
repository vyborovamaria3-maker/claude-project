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
  const updated = await prisma.$transaction(async (tx) => {
    const claim = await tx.paymentTransaction.updateMany({
      where: {
        id: payment.id,
        userId,
        status: PaymentStatus.PENDING,
        expiresAt: { gt: now }
      },
      data: {
        status: PaymentStatus.CONFIRMED,
        signature,
        confirmedAt: now
      }
    });

    if (claim.count !== 1) {
      throw new AppError(409, "Payment was already processed", "PAYMENT_ALREADY_PROCESSED");
    }

    const activeSubscription = await tx.subscription.findFirst({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        endsAt: { gt: now }
      },
      orderBy: { endsAt: "desc" }
    });

    const baseDate = activeSubscription?.endsAt && activeSubscription.endsAt > now
      ? activeSubscription.endsAt
      : now;
    const endsAt = addBillingPeriod(baseDate, payment.period);

    const subscription = activeSubscription
      ? await tx.subscription.update({
          where: { id: activeSubscription.id },
          data: {
            planId: payment.planId,
            period: payment.period,
            status: SubscriptionStatus.ACTIVE,
            endsAt,
            reminderSentAt: null
          }
        })
      : await tx.subscription.create({
          data: {
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
      data: { subscriptionId: subscription.id },
      include: { plan: true, user: true, subscription: true }
    });
  });

  const endsAt = updated.subscription?.endsAt;
  await sendTelegramMessage(
    updated.user,
    `Payment confirmed. Your ${updated.plan.name} subscription is active until ${endsAt?.toISOString().slice(0, 10) ?? "n/a"}.`,
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
  if (env.NODE_ENV === "production") {
    throw new AppError(
      503,
      "USDC checkout is disabled until a live SOL/USD price oracle is configured",
      "USDC_PRICE_ORACLE_REQUIRED"
    );
  }

  const demoSolUsd = 150;
  return Number((amountSol * demoSolUsd).toFixed(6));
}
