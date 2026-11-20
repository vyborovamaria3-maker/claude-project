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
vi.stubEnv("TREASURY_USDC_TOKEN_ACCOUNT", "TokenAcct11111111111111111111111111111111");
vi.stubEnv("USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
vi.stubEnv("PAYMENT_CONFIRMATION_COMMITMENT", "finalized");

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

  it("does not accept a merely confirmed signature when finalization is required", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");

    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: {
        slot: 1,
        confirmations: 1,
        err: null,
        confirmationStatus: "confirmed"
      }
    } as never);
    const parsedSpy = vi.spyOn(solanaConnection, "getParsedTransaction");

    await expect(verifySolanaPayment({
      signature: "7".repeat(88),
      nonce: "solsub-finality",
      expectedAmount: 1,
      currency: PaymentCurrency.SOL
    })).rejects.toMatchObject({ code: "PAYMENT_NOT_FINALIZED" });
    expect(parsedSpy).not.toHaveBeenCalled();
  });

  it("does not accept a nonce emitted only by arbitrary program logs or a lookalike program id", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");
    const nonce = "solsub-arbitrary-log";
    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }
    } as never);
    vi.spyOn(solanaConnection, "getParsedTransaction").mockResolvedValue({
      meta: { err: null, logMessages: [`Program log: ${nonce}`] },
      transaction: { message: { instructions: [
        {
          programId: { equals: () => true },
          parsed: { type: "transfer", info: { destination: "11111111111111111111111111111111", lamports: 1_000_000_000 } }
        },
        {
          programId: { toBase58: () => "FakeMemoProgram111111111111111111111111111111" },
          data: nonce
        }
      ] } }
    } as never);

    await expect(verifySolanaPayment({
      signature: "8".repeat(88),
      nonce,
      expectedAmount: 1,
      currency: PaymentCurrency.SOL
    })).rejects.toMatchObject({ code: "PAYMENT_NONCE_MISMATCH" });
  });

  it("requires an exact parsed SPL Memo value rather than a substring", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");
    const nonce = "solsub-exact-memo";
    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }
    } as never);
    vi.spyOn(solanaConnection, "getParsedTransaction").mockResolvedValue({
      meta: { err: null, logMessages: [] },
      transaction: { message: { instructions: [
        { program: "spl-memo", parsed: `${nonce}-suffix` }
      ] } }
    } as never);

    await expect(verifySolanaPayment({
      signature: "9".repeat(88),
      nonce,
      expectedAmount: 1,
      currency: PaymentCurrency.SOL
    })).rejects.toMatchObject({ code: "PAYMENT_NONCE_MISMATCH" });
  });

  it("accepts the exact parsed SPL Memo instruction", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");
    const nonce = "solsub-valid-memo";
    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }
    } as never);
    vi.spyOn(solanaConnection, "getParsedTransaction").mockResolvedValue({
      meta: { err: null, logMessages: [] },
      transaction: { message: { instructions: [
        { program: "spl-memo", parsed: nonce },
        {
          programId: { equals: () => true },
          parsed: { type: "transfer", info: { destination: "11111111111111111111111111111111", lamports: 1_000_000_000 } }
        }
      ] } }
    } as never);

    await expect(verifySolanaPayment({
      signature: "A".repeat(88),
      nonce,
      expectedAmount: 1,
      currency: PaymentCurrency.SOL
    })).resolves.toBeUndefined();
  });


  it("rejects a USDC transfer when transaction token-balance mint differs from configured USDC", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");
    const treasury = "11111111111111111111111111111111";
    const treasuryTokenAccount = "TokenAcct11111111111111111111111111111111";
    const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }
    } as never);
    vi.spyOn(solanaConnection, "getParsedTransaction").mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint, owner: treasury, uiTokenAmount: { amount: "0", decimals: 6, uiAmount: 0, uiAmountString: "0" } }],
        postTokenBalances: [{ accountIndex: 1, mint: "FakeMint111111111111111111111111111111111", owner: treasury, uiTokenAmount: { amount: "1000000", decimals: 6, uiAmount: 1, uiAmountString: "1" } }]
      },
      transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => "ComputeBudget111111111111111111111111111111" } }, { pubkey: { toBase58: () => treasuryTokenAccount } }], instructions: [
        { program: "spl-memo", parsed: "usdc-mint-check" },
        { program: "spl-token", parsed: { type: "transfer", info: { destination: treasuryTokenAccount, amount: "1000000" } } }
      ] } }
    } as never);

    await expect(verifySolanaPayment({
      signature: "B".repeat(88), nonce: "usdc-mint-check", expectedAmount: 1, currency: PaymentCurrency.USDC
    })).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
  });

  it("requires the configured treasury owner and six USDC decimals in token-balance evidence", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");
    const treasury = "11111111111111111111111111111111";
    const treasuryTokenAccount = "TokenAcct11111111111111111111111111111111";
    const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }
    } as never);
    vi.spyOn(solanaConnection, "getParsedTransaction").mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint, owner: "WrongOwner111111111111111111111111111111", uiTokenAmount: { amount: "0", decimals: 9, uiAmount: 0, uiAmountString: "0" } }],
        postTokenBalances: [{ accountIndex: 1, mint, owner: "WrongOwner111111111111111111111111111111", uiTokenAmount: { amount: "1000000", decimals: 9, uiAmount: 1, uiAmountString: "1" } }]
      },
      transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => "ComputeBudget111111111111111111111111111111" } }, { pubkey: { toBase58: () => treasuryTokenAccount } }], instructions: [
        { program: "spl-memo", parsed: "usdc-owner-check" },
        { program: "spl-token", parsed: { type: "transfer", info: { destination: treasuryTokenAccount, amount: "1000000" } } }
      ] } }
    } as never);

    await expect(verifySolanaPayment({
      signature: "C".repeat(88), nonce: "usdc-owner-check", expectedAmount: 1, currency: PaymentCurrency.USDC
    })).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
  });


  it("accepts a USDC transfer only when mint, treasury owner, decimals and balance delta match", async () => {
    const { PaymentCurrency } = await import("@prisma/client");
    const { solanaConnection, verifySolanaPayment } = await import("../src/services/solana.service");
    const treasury = "11111111111111111111111111111111";
    const treasuryTokenAccount = "TokenAcct11111111111111111111111111111111";
    const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    vi.spyOn(solanaConnection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }
    } as never);
    vi.spyOn(solanaConnection, "getParsedTransaction").mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint, owner: treasury, uiTokenAmount: { amount: "2500000", decimals: 6, uiAmount: 2.5, uiAmountString: "2.5" } }],
        postTokenBalances: [{ accountIndex: 1, mint, owner: treasury, uiTokenAmount: { amount: "3500000", decimals: 6, uiAmount: 3.5, uiAmountString: "3.5" } }]
      },
      transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => "ComputeBudget111111111111111111111111111111" } }, { pubkey: { toBase58: () => treasuryTokenAccount } }], instructions: [
        { program: "spl-memo", parsed: "usdc-valid-check" },
        { program: "spl-token", parsed: { type: "transfer", info: { destination: treasuryTokenAccount, amount: "1000000" } } }
      ] } }
    } as never);

    await expect(verifySolanaPayment({
      signature: "D".repeat(88), nonce: "usdc-valid-check", expectedAmount: 1, currency: PaymentCurrency.USDC
    })).resolves.toBeUndefined();
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
