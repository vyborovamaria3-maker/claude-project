import {
  Connection,
  Keypair,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";

export const USDT_SOLANA_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export type SolanaPaymentCurrency = "SOL" | "USDT";

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

export function decimalToBaseUnits(value: string, decimals: number): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error("Subscription price is invalid");
  }

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Subscription price has more than ${decimals} decimals`);
  }

  const base = BigInt(whole) * pow10(decimals);
  const fractional = BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  const total = base + fractional;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Subscription price is too large");
  }
  return Number(total);
}

export function baseUnitsToDecimal(amount: number, decimals: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Payment amount is invalid");
  }
  const raw = BigInt(amount);
  const divisor = pow10(decimals);
  const whole = raw / divisor;
  const fraction = (raw % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function generatePaymentReference(): string {
  return Keypair.generate().publicKey.toBase58();
}

export function validateRecipientWallet(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Recipient Solana wallet is not configured in admin");
  }
  return new PublicKey(normalized).toBase58();
}

export function buildSolanaPayUrl(input: {
  recipient: string;
  reference: string;
  currency: SolanaPaymentCurrency;
  totalAmount: number;
}): string {
  const decimals = input.currency === "SOL" ? 9 : 6;
  const amount = baseUnitsToDecimal(input.totalAmount, decimals);
  const params = new URLSearchParams({
    amount,
    reference: input.reference,
    label: "Solana Launcher Pro",
    message: "30-day Solana Launcher Pro subscription",
  });
  if (input.currency === "USDT") {
    params.set("spl-token", USDT_SOLANA_MINT);
  }
  return `solana:${input.recipient}?${params.toString()}`;
}

export function getSubscriptionRpcUrl(): string {
  return (
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_RPC_URL?.trim() ||
    "https://api.mainnet-beta.solana.com"
  );
}

function isParsedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction
): instruction is ParsedInstruction {
  return "parsed" in instruction;
}

function validateSolTransfer(
  instructions: Array<ParsedInstruction | PartiallyDecodedInstruction>,
  recipient: string,
  expectedLamports: bigint
): boolean {
  let received = 0n;
  for (const instruction of instructions) {
    if (!isParsedInstruction(instruction) || instruction.program !== "system") continue;
    const parsed = instruction.parsed as {
      type?: string;
      info?: { destination?: string; lamports?: number | string };
    };
    if (parsed.type !== "transfer" || parsed.info?.destination !== recipient) continue;
    if (parsed.info.lamports === undefined) continue;
    try {
      received += BigInt(String(parsed.info.lamports));
    } catch {
      continue;
    }
  }
  return received === expectedLamports;
}

function validateUsdtTransfer(
  meta: NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>["meta"],
  recipient: string,
  expectedAmount: bigint
): boolean {
  if (!meta) return false;
  const preBalances = meta.preTokenBalances || [];
  const postBalances = meta.postTokenBalances || [];
  let received = 0n;

  for (const post of postBalances) {
    if (post.mint !== USDT_SOLANA_MINT || post.owner !== recipient) continue;
    const pre = preBalances.find(
      (candidate) =>
        candidate.accountIndex === post.accountIndex && candidate.mint === USDT_SOLANA_MINT
    );
    try {
      const postAmount = BigInt(post.uiTokenAmount.amount);
      const preAmount = BigInt(pre?.uiTokenAmount.amount || "0");
      received += postAmount - preAmount;
    } catch {
      return false;
    }
  }

  return received === expectedAmount;
}

export async function findVerifiedSolanaPayment(input: {
  rpcUrl: string;
  reference: string;
  recipient: string;
  currency: SolanaPaymentCurrency;
  totalAmount: number;
  createdAt: string;
}): Promise<string | null> {
  const reference = new PublicKey(input.reference);
  const recipient = new PublicKey(input.recipient).toBase58();
  if (!Number.isSafeInteger(input.totalAmount) || input.totalAmount <= 0) {
    throw new Error("Expected payment amount is invalid");
  }
  const expectedAmount = BigInt(input.totalAmount);
  const createdAfter = Math.floor(new Date(input.createdAt).getTime() / 1000) - 300;
  if (!Number.isFinite(createdAfter)) {
    throw new Error("Subscription order timestamp is invalid");
  }

  const connection = new Connection(input.rpcUrl, "confirmed");
  const signatures = await connection.getSignaturesForAddress(reference, { limit: 20 });

  for (const signatureInfo of signatures) {
    if (signatureInfo.err) continue;
    if (
      signatureInfo.confirmationStatus !== "confirmed" &&
      signatureInfo.confirmationStatus !== "finalized"
    ) {
      continue;
    }
    if (signatureInfo.blockTime != null && signatureInfo.blockTime < createdAfter) continue;

    const transaction = await connection.getParsedTransaction(signatureInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction || transaction.meta?.err) continue;

    const hasReference = transaction.transaction.message.accountKeys.some(
      (key) => key.pubkey.toBase58() === reference.toBase58()
    );
    if (!hasReference) continue;

    const valid =
      input.currency === "SOL"
        ? validateSolTransfer(
            transaction.transaction.message.instructions,
            recipient,
            expectedAmount
          )
        : validateUsdtTransfer(transaction.meta, recipient, expectedAmount);

    if (valid) return signatureInfo.signature;
  }

  return null;
}
