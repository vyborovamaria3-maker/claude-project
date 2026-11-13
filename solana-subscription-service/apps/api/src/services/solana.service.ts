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
  const confirmationRank = confirmation === "finalized" ? 2 : confirmation === "confirmed" ? 1 : 0;
  const requiredRank = env.PAYMENT_CONFIRMATION_COMMITMENT === "finalized" ? 2 : 1;
  if (confirmationRank < requiredRank) {
    throw new AppError(
      409,
      requiredRank === 2 ? "Transaction is not finalized yet" : "Transaction is not confirmed yet",
      requiredRank === 2 ? "PAYMENT_NOT_FINALIZED" : "PAYMENT_NOT_CONFIRMED"
    );
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
  // Only a parsed instruction from the recognized SPL Memo program is
  // authoritative. Arbitrary program logs and program IDs containing the
  // word "Memo" are attacker-controlled and must never bind a payment nonce.
  const memoFound = allInstructions.some((ix) =>
    "program" in ix &&
    ix.program === "spl-memo" &&
    typeof ix.parsed === "string" &&
    ix.parsed === check.nonce
  );
  if (!memoFound) {
    throw new AppError(400, "Payment nonce was not found in SPL Memo instruction", "PAYMENT_NONCE_MISMATCH");
  }

  if (check.currency === PaymentCurrency.SOL) {
    verifySolTransfer(allInstructions, check.expectedAmount);
  } else {
    // Parsed account keys are wrappers; the public key is always on `pubkey`.
    const accountKeys = tx.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
    verifyUsdcTransfer(allInstructions, check.expectedAmount, tx.meta, accountKeys);
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

function verifyUsdcTransfer(
  instructions: readonly unknown[],
  expectedAmount: number,
  meta: NonNullable<Awaited<ReturnType<typeof solanaConnection.getParsedTransaction>>>["meta"],
  accountKeys: readonly string[],
) {
  const expectedBaseUnits = BigInt(Math.round(expectedAmount * 1_000_000));
  const treasuryTokenAccount = env.TREASURY_USDC_TOKEN_ACCOUNT;
  const treasuryTokenIndex = accountKeys.indexOf(treasuryTokenAccount);
  if (treasuryTokenIndex < 0 || !meta?.preTokenBalances || !meta.postTokenBalances) {
    throw new AppError(400, "USDC token-account balance evidence is missing", "PAYMENT_TOKEN_ACCOUNT_MISMATCH");
  }

  const matchingTransfer = instructions.some((ix) => {
    const parsedIx = ix as ParsedInstruction;
    const info = parsedIx.parsed?.info;
    if (
      parsedIx.program !== "spl-token" ||
      !["transfer", "transferChecked"].includes(parsedIx.parsed?.type ?? "") ||
      info?.destination !== treasuryTokenAccount
    ) return false;

    // transferChecked exposes the mint directly. Unchecked transfer is bound
    // to the configured mint below using the transaction's pre/post token balances.
    if (info.mint !== undefined && info.mint !== env.USDC_MINT) return false;
    const rawAmount = info.tokenAmount?.amount ?? info.amount;
    try {
      return rawAmount !== undefined && BigInt(String(rawAmount)) === expectedBaseUnits;
    } catch {
      return false;
    }
  });

  const before = meta.preTokenBalances.find((balance) => balance.accountIndex === treasuryTokenIndex);
  const after = meta.postTokenBalances.find((balance) => balance.accountIndex === treasuryTokenIndex);
  const validBalanceEvidence = Boolean(
    before &&
    after &&
    before.mint === env.USDC_MINT &&
    after.mint === env.USDC_MINT &&
    before.uiTokenAmount.decimals === 6 &&
    after.uiTokenAmount.decimals === 6 &&
    before.owner === env.TREASURY_WALLET &&
    after.owner === env.TREASURY_WALLET &&
    BigInt(after.uiTokenAmount.amount) - BigInt(before.uiTokenAmount.amount) === expectedBaseUnits
  );

  if (!matchingTransfer || !validBalanceEvidence) {
    throw new AppError(400, "USDC mint, token account owner, decimals, amount or destination mismatch", "PAYMENT_AMOUNT_MISMATCH");
  }
}
