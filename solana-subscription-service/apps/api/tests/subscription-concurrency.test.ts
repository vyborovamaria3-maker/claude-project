import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingPeriod, PaymentCurrency, PaymentStatus, SubscriptionStatus, SubscriptionTier } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  prisma: { paymentTransaction: { findFirst: vi.fn() }, $transaction: vi.fn() },
  verifySolanaPayment: vi.fn(),
  sendTelegramMessage: vi.fn()
}));
vi.mock("../src/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("../src/services/solana.service", () => ({
  buildSolanaPayUrl: vi.fn(),
  verifySolanaPayment: mocks.verifySolanaPayment
}));
vi.mock("../src/services/telegram.service", () => ({ sendTelegramMessage: mocks.sendTelegramMessage }));

vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
vi.stubEnv("API_PUBLIC_URL", "http://localhost:4000");
vi.stubEnv("WEB_PUBLIC_URL", "http://localhost:3000");
vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
vi.stubEnv("REDIS_URL", "redis://localhost:6379");
vi.stubEnv("JWT_ACCESS_SECRET", "a".repeat(64));
vi.stubEnv("JWT_REFRESH_SECRET", "b".repeat(64));
vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:ABC");
vi.stubEnv("TELEGRAM_BOT_USERNAME", "SolSubBot");
vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "secret-secret");
vi.stubEnv("TELEGRAM_WEBAPP_URL", "http://localhost:3000");
vi.stubEnv("RPC_ENDPOINT", "https://api.devnet.solana.com");
vi.stubEnv("TREASURY_WALLET", "11111111111111111111111111111111");
vi.stubEnv("TREASURY_USDC_TOKEN_ACCOUNT", "11111111111111111111111111111111");
vi.stubEnv("USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
vi.stubEnv("PAYMENT_CONFIRMATION_COMMITMENT", "finalized");

afterEach(() => vi.restoreAllMocks());

function createHarness() {
  const userId = "user-1";
  const now = new Date();
  const payments = new Map<string, any>();
  for (const id of ["payment-1", "payment-2"]) {
    payments.set(id, {
      id, userId, planId: SubscriptionTier.BASIC, period: BillingPeriod.MONTHLY,
      currency: PaymentCurrency.SOL, expectedAmount: 1, nonce: id, paymentUrl: "solana:test",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000), status: PaymentStatus.PENDING,
      signature: null, confirmedAt: null, subscriptionId: null,
      plan: { name: "Basic" }, user: { telegramId: "123456" }
    });
  }
  const state: { payments: Map<string, any>; subscription: any | null } = { payments, subscription: null };
  let lockTail = Promise.resolve();
  async function acquireUserLock() {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  mocks.prisma.paymentTransaction.findFirst.mockImplementation(async ({ where }: any) => {
    const payment = state.payments.get(where.id);
    return payment ? { ...payment } : null;
  });
  mocks.verifySolanaPayment.mockResolvedValue(undefined);
  mocks.sendTelegramMessage.mockResolvedValue(undefined);
  mocks.prisma.$transaction.mockImplementation(async (callback: any) => {
    let releaseLock: (() => void) | undefined;
    const tx: any = {
      $queryRaw: async () => {
        releaseLock = await acquireUserLock();
        return [{ id: userId }];
      },
      paymentTransaction: {
        findFirst: async ({ where }: any) => {
          const payment = state.payments.get(where.id);
          return payment ? { ...payment } : null;
        },
        updateMany: async ({ where, data }: any) => {
          const payment = state.payments.get(where.id);
          if (!payment || payment.status !== where.status || payment.expiresAt <= where.expiresAt.gt) return { count: 0 };
          Object.assign(payment, data);
          return { count: 1 };
        },
        update: async ({ where, data }: any) => {
          const payment = state.payments.get(where.id)!;
          Object.assign(payment, data);
          return { ...payment, plan: payment.plan, user: payment.user, subscription: state.subscription };
        }
      },
      subscription: {
        updateMany: async ({ where, data }: any) => {
          const row = state.subscription;
          if (row && row.userId === where.userId && row.status === where.status &&
              (!row.endsAt || row.endsAt <= where.OR[1].endsAt.lte)) {
            Object.assign(row, data);
            return { count: 1 };
          }
          return { count: 0 };
        },
        findFirst: async () => state.subscription && state.subscription.endsAt > new Date()
          ? { ...state.subscription } : null,
        create: async ({ data }: any) => {
          state.subscription = { id: "subscription-1", ...data };
          return { ...state.subscription };
        },
        update: async ({ data }: any) => {
          Object.assign(state.subscription, data);
          return { ...state.subscription };
        }
      }
    };
    try { return await callback(tx); }
    finally { releaseLock?.(); }
  });
  return state;
}

describe("subscription payment concurrency", () => {
  it("serializes two distinct payments for one user and extends one subscription twice", async () => {
    const state = createHarness();
    const { confirmPayment } = await import("../src/services/subscription.service");
    const [first, second] = await Promise.all([
      confirmPayment("user-1", "payment-1", "signature-1"),
      confirmPayment("user-1", "payment-2", "signature-2")
    ]);
    expect(first.subscription?.id).toBe("subscription-1");
    expect(second.subscription?.id).toBe("subscription-1");
    expect(state.subscription).not.toBeNull();
    expect(state.subscription.status).toBe(SubscriptionStatus.ACTIVE);
    expect(state.payments.get("payment-1").status).toBe(PaymentStatus.CONFIRMED);
    expect(state.payments.get("payment-2").status).toBe(PaymentStatus.CONFIRMED);
    expect(state.subscription.endsAt.getTime()).toBeGreaterThan(Date.now() + 50 * 24 * 60 * 60 * 1000);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(mocks.sendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  it("does not send duplicate confirmation for the same payment and signature", async () => {
    const state = createHarness();
    const { confirmPayment } = await import("../src/services/subscription.service");
    await confirmPayment("user-1", "payment-1", "signature-1");
    const notifications = mocks.sendTelegramMessage.mock.calls.length;
    const result = await confirmPayment("user-1", "payment-1", "signature-1");
    expect(result.status).toBe(PaymentStatus.CONFIRMED);
    expect(mocks.sendTelegramMessage).toHaveBeenCalledTimes(notifications);
    expect(state.payments.get("payment-1").subscriptionId).toBe("subscription-1");
  });
});
