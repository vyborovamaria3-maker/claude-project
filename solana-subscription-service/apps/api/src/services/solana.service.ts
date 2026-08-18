import { LAMPORTS_PER_SOL, ParsedInstruction, PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import { PaymentCurrency } from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

export const solanaConnection = new Connection(env.RPC_ENDPOINT, env.PAYMENT_CONFIRMATION_COMMITMENT);

export interface SolanaPaymentCheck {
  signature: string;
  nonce: string;
  expectedAmount: number;
  currency: PaymentCurrency;
}

export function buildSolanaPayUrl(input: {
  recipient: string;
  amount: number;
  currency: PaymentCurrency;
  memo: string;
  label: string;
  message: string;
}) {
  const params = new URLSearchParams({
    amount: String(input.amount),
    label: input.label,
    message: input.message,
    memo: input.memo
  });
  if (input.currency === PaymentCurrency.USDC) {
    params.set("spl-token", env.USDC_MINT);
  }
  return `solana:${input.recipient}?${params.toString()}`;
}

export async function verifySolanaPayment(check: SolanaPaymentCheck) {
  const status = await solanaConnection.getSignatureStatus(check.signature, { searchTransactionHistory: true });
  if (status.value?.err) {
    throw new AppError(400, "Solana transaction failed on-chain", "PAYMENT_TX_FAILED");
  }

  const confirmation = status.value?.confirmationStatus;
  if (!confirmation || !["confirmed", "finalized"].includes(confirmation)) {
    throw new AppError(409, "Transaction is not confirmed yet", "PAYMENT_NOT_CONFIRMED");
  }

  const tx = await solanaConnection.getParsedTransaction(check.signature, {
    commitment: env.PAYMENT_CONFIRMATION_COMMITMENT,
    maxSupportedTransactionVersion: 0
  });
  if (!tx) {
    throw new AppError(404, "Solana transaction not found", "PAYMENT_TX_NOT_FOUND");
  }
  if (tx.meta?.err) {
    throw new AppError(400, "Solana transaction failed on-chain", "PAYMENT_TX_FAILED");
  }

  const allInstructions = tx.transaction.message.instructions;
  const memoFound = allInstructions.some((ix) => {
    if ("program" in ix && ix.program === "spl-memo") {
      return String(ix.parsed ?? "").includes(check.nonce);
    }
    return "programId" in ix && ix.programId.toBase58().includes("Memo") && JSON.stringify(ix).includes(check.nonce);
  });
  if (!memoFound && !JSON.stringify(tx.meta?.logMessages ?? []).includes(check.nonce)) {
    throw new AppError(400, "Payment nonce was not found in memo", "PAYMENT_NONCE_MISMATCH");
  }

  if (check.currency === PaymentCurrency.SOL) {
    verifySolTransfer(allInstructions, check.expectedAmount);
  } else {
    verifyUsdcTransfer(allInstructions, check.expectedAmount);
  }
}

function verifySolTransfer(instructions: readonly unknown[], expectedAmount: number) {
  const expectedLamports = Math.round(expectedAmount * LAMPORTS_PER_SOL);
  const treasury = new PublicKey(env.TREASURY_WALLET).toBase58();

  const ok = instructions.some((ix) => {
    const parsedIx = ix as ParsedInstruction;
    return (
      parsedIx.programId?.equals(SystemProgram.programId) &&
      parsedIx.parsed?.type === "transfer" &&
      parsedIx.parsed.info?.destination === treasury &&
      Number(parsedIx.parsed.info?.lamports) === expectedLamports
    );
  });

  if (!ok) {
    throw new AppError(400, "SOL transfer amount or destination mismatch", "PAYMENT_AMOUNT_MISMATCH");
  }
}

function verifyUsdcTransfer(instructions: readonly unknown[], expectedAmount: number) {
  const expectedBaseUnits = Math.round(expectedAmount * 1_000_000);
  const treasuryTokenAccount = env.TREASURY_USDC_TOKEN_ACCOUNT;

  const ok = instructions.some((ix) => {
    const parsedIx = ix as ParsedInstruction;
    const amountInfo = parsedIx.parsed?.info?.tokenAmount;
    return (
      parsedIx.program === "spl-token" &&
      ["transfer", "transferChecked"].includes(parsedIx.parsed?.type) &&
      parsedIx.parsed.info?.destination === treasuryTokenAccount &&
      Number(amountInfo?.amount ?? parsedIx.parsed.info?.amount) === expectedBaseUnits
    );
  });

  if (!ok) {
    throw new AppError(400, "USDC transfer amount or destination mismatch", "PAYMENT_AMOUNT_MISMATCH");
  }
}
