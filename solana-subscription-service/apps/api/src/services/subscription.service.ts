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
      include: { user: true, plan: true, subscription: true }
    }),
    "Payment not found"
  );

  if (payment.status === PaymentStatus.CONFIRMED) {
    if (payment.signature === signature) return payment;
    throw new AppError(409, "Payment was already confirmed with another signature", "PAYMENT_ALREADY_PROCESSED");
  }
  if (payment.status !== PaymentStatus.PENDING || payment.expiresAt <= new Date()) {
    throw new AppError(400, "Payment is not payable anymore", "PAYMENT_NOT_PAYABLE");
  }

  // Verify the chain before taking the per-user database lock. State is re-read
  // under the lock below, so two different payments cannot extend from the same
  // stale subscription end timestamp.
  await verifySolanaPayment({
    signature,
    nonce: payment.nonce,
    expectedAmount: Number(payment.expectedAmount),
    currency: payment.currency
  });

  const outcome = await prisma.$transaction(async (tx) => {
    const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!lockedUsers.length) {
      throw new AppError(404, "User not found", "USER_NOT_FOUND");
    }

    const currentPayment = assertFound(
      await tx.paymentTransaction.findFirst({
        where: { id: payment.id, userId },
        include: { user: true, plan: true, subscription: true }
      }),
      "Payment not found"
    );

    // Another request may have confirmed this exact payment while RPC
    // verification was in flight. Return it idempotently, without extending
    // the subscription or sending a second notification.
    if (currentPayment.status === PaymentStatus.CONFIRMED) {
      if (currentPayment.signature === signature) {
        return { payment: currentPayment, newlyConfirmed: false };
      }
      throw new AppError(409, "Payment was already confirmed with another signature", "PAYMENT_ALREADY_PROCESSED");
    }

    const now = new Date();
    if (currentPayment.status !== PaymentStatus.PENDING || currentPayment.expiresAt <= now) {
      throw new AppError(400, "Payment is not payable anymore", "PAYMENT_NOT_PAYABLE");
    }

    const claim = await tx.paymentTransaction.updateMany({
      where: {
        id: currentPayment.id,
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

    // Expired ACTIVE rows are not live entitlements. Retire them before
    // applying the partial unique index on one ACTIVE row per user.
    await tx.subscription.updateMany({
      where: {
        userId,
        status: SubscriptionStatus.ACTIVE,
        OR: [{ endsAt: null }, { endsAt: { lte: now } }]
      },
      data: { status: SubscriptionStatus.EXPIRED }
    });

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
    const endsAt = addBillingPeriod(baseDate, currentPayment.period);

    const subscription = activeSubscription
      ? await tx.subscription.update({
          where: { id: activeSubscription.id },
          data: {
            planId: currentPayment.planId,
            period: currentPayment.period,
            status: SubscriptionStatus.ACTIVE,
            endsAt,
            reminderSentAt: null
          }
        })
      : await tx.subscription.create({
          data: {
            userId,
            planId: currentPayment.planId,
            period: currentPayment.period,
            status: SubscriptionStatus.ACTIVE,
            startsAt: now,
            endsAt
          }
        });

    const updatedPayment = await tx.paymentTransaction.update({
      where: { id: currentPayment.id },
      data: { subscriptionId: subscription.id },
      include: { plan: true, user: true, subscription: true }
    });
    return { payment: updatedPayment, newlyConfirmed: true };
  });

  if (outcome.newlyConfirmed) {
    const endsAt = outcome.payment.subscription?.endsAt;
    await sendTelegramMessage(
      outcome.payment.user,
      `Payment confirmed. Your ${outcome.payment.plan.name} subscription is active until ${endsAt?.toISOString().slice(0, 10) ?? "n/a"}.`,
      NotificationType.PAYMENT_CONFIRMED
    );
  }

  return outcome.payment;
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
