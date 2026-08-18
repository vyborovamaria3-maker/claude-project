import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifySolanaPayment", () => {
  it("rejects a finalized signature whose RPC status contains an error", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");

    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: {
        slot: 1,
        confirmations: null,
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "finalized"
      }
    } as never);
    const parsedSpy = vi.spyOn(solanaConnection, "getParsedTransaction");

    await expect(
      verifySolanaPayment({
        signature: "5".repeat(88),
        nonce: "solsub-test",
        expectedAmount: 1,
        currency: PaymentCurrency.SOL
      })
    ).rejects.toMatchObject({ code: "PAYMENT_TX_FAILED" });
    expect(parsedSpy).not.toHaveBeenCalled();
  });

  it("rejects a parsed transaction whose metadata contains an error", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");

    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: {
        slot: 1,
        confirmations: null,
        err: null,
        confirmationStatus: "finalized"
      }
    } as never);
    vi.spyOn(solanaConnection, "getParsedTransaction").mockResolvedValue({
      meta: { err: { InstructionError: [0, "Custom"] } },
      transaction: { message: { instructions: [] } }
    } as never);

    await expect(
      verifySolanaPayment({
        signature: "6".repeat(88),
        nonce: "solsub-test",
        expectedAmount: 1,
        currency: PaymentCurrency.SOL
      })
    ).rejects.toMatchObject({ code: "PAYMENT_TX_FAILED" });
  });
});
