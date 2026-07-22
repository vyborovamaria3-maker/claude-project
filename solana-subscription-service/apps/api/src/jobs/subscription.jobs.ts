import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { NotificationType, PaymentStatus, SubscriptionStatus } from "@prisma/client";
import { redis } from "../lib/redis";
import { prisma } from "../lib/prisma";
import { sendTelegramMessage } from "../services/telegram.service";

const bullConnection = redis as unknown as ConnectionOptions;

export const maintenanceQueue = new Queue("maintenance", { connection: bullConnection });

export async function scheduleRecurringJobs() {
  await maintenanceQueue.upsertJobScheduler(
    "subscription-maintenance",
    { every: 60 * 60 * 1000 },
    { name: "subscription-maintenance", data: {} }
  );
  await maintenanceQueue.upsertJobScheduler(
    "payment-expiration",
    { every: 10 * 60 * 1000 },
    { name: "payment-expiration", data: {} }
  );
}

export function startMaintenanceWorker() {
  return new Worker(
    "maintenance",
    async (job) => {
      if (job.name === "subscription-maintenance") {
        await sendRenewalReminders();
        await expireSubscriptions();
      }
      if (job.name === "payment-expiration") {
        await expirePaymentIntents();
      }
    },
    { connection: bullConnection }
  );
}

async function sendRenewalReminders() {
  const now = new Date();
  const inThreeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const subscriptions = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      reminderSentAt: null,
      endsAt: { gt: now, lte: inThreeDays }
    },
    include: { user: true, plan: true }
  });

  for (const subscription of subscriptions) {
    await sendTelegramMessage(
      subscription.user,
      `Your ${subscription.plan.name} subscription ends on ${subscription.endsAt?.toISOString().slice(0, 10)}. Open the app to renew.`,
      NotificationType.RENEWAL_REMINDER
    );
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { reminderSentAt: new Date() }
    });
  }
}

async function expireSubscriptions() {
  const expired = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      endsAt: { lt: new Date() }
    },
    include: { user: true, plan: true }
  });

  for (const subscription of expired) {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: SubscriptionStatus.EXPIRED }
    });
    await sendTelegramMessage(
      subscription.user,
      `Your ${subscription.plan.name} subscription has expired. Premium access is now locked until renewal.`,
      NotificationType.SUBSCRIPTION_EXPIRED
    );
  }
}

async function expirePaymentIntents() {
  await prisma.paymentTransaction.updateMany({
    where: {
      status: PaymentStatus.PENDING,
      expiresAt: { lt: new Date() }
    },
    data: { status: PaymentStatus.EXPIRED, failureReason: "Payment intent expired" }
  });
}
