/**
 * Confidential funding via Light Protocol (ZK Compression).
 *
 * Flow:
 *   1. User signs a regular transfer from Phantom -> master wallet (one tx).
 *   2. Master wallet compresses SOL into a compressed account (privacy layer in).
 *   3. Master wallet performs compressed transfers to each recipient.
 *      Compressed accounts live inside a state Merkle tree, so individual
 *      ownership/amounts are not directly tied to a regular SPL/SOL account.
 *   4. Recipients can later decompress when they actually need plain SOL.
 *
 * Budget notes:
 *   - Each compressed account costs ~5_000 lamports (vs ~890_880 rent for regular acc).
 *   - Bundling many compressed transfers into one tx amortizes the proof cost.
 *
 * IMPORTANT: requires a Helius RPC URL with ZK Compression methods enabled.
 *   Set NEXT_PUBLIC_HELIUS_RPC_URL in your .env.local, e.g.:
 *     NEXT_PUBLIC_HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
 */

import {
 
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createRpc,
  type Rpc,
  bn,
  compress,
  transfer as compressedTransfer,
  decompress,
} from "@lightprotocol/stateless.js";

export interface ConfidentialFundParams {
  /** Master wallet that temporarily holds funds and performs compressed transfers. */
  masterKeypair: Keypair;
  /** Recipients with target lamport amounts. */
  recipients: { publicKey: PublicKey; lamports: number }[];
  /** Total lamports already deposited to master from Phantom (sum of recipients + buffer for fees). */
  totalLamports: number;
  /** Optional progress callback. */
  onProgress?: (step: ConfidentialStep) => void;
}

export type ConfidentialStep =
  | { kind: "compress"; lamports: number }
  | { kind: "transfer"; recipient: string; lamports: number; index: number; total: number }
  | { kind: "done"; signatures: string[] };

function getRpc(): Rpc {
  const url =
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "";
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_HELIUS_RPC_URL is not configured. ZK Compression requires a Helius RPC endpoint."
    );
  }
  return createRpc(url, url);
}

/**
 * Build the unsigned Phantom -> master deposit transaction.
 * Caller signs it with Phantom and broadcasts before calling runConfidentialFund.
 */
export function buildPhantomDepositTx(
  payer: PublicKey,
  master: PublicKey,
  lamports: number,
  recentBlockhash: string
): Transaction {
  const tx = new Transaction({ feePayer: payer, recentBlockhash }).add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: master,
      lamports,
    })
  );
  return tx;
}

/**
 * Run the confidential distribution: compress on master, then compressed transfers
 * to each recipient. Recipients can later call decompressForRecipient().
 */
export async function runConfidentialFund(
  params: ConfidentialFundParams
): Promise<string[]> {
  const { masterKeypair, recipients, totalLamports, onProgress } = params;
  const rpc = getRpc();
  const signatures: string[] = [];

  // 1. Compress all SOL on the master into a compressed account.
  onProgress?.({ kind: "compress", lamports: totalLamports });
  const compressSig = await compress(
    rpc,
    masterKeypair,
    bn(totalLamports),
    masterKeypair.publicKey
  );
  signatures.push(compressSig);

  // 2. Compressed transfers to each recipient.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    onProgress?.({
      kind: "transfer",
      recipient: r.publicKey.toBase58(),
      lamports: r.lamports,
      index: i + 1,
      total: recipients.length,
    });
    const sig = await compressedTransfer(
      rpc,
      masterKeypair,
      bn(r.lamports),
      masterKeypair,
      r.publicKey
    );
    signatures.push(sig);
  }

  onProgress?.({ kind: "done", signatures });
  return signatures;
}

/**
 * Recipient-side helper: decompress all compressed SOL owned by `owner`
 * back into a regular SOL balance. Recipient must sign.
 */
export async function decompressForRecipient(
  ownerKeypair: Keypair,
  lamports: number
): Promise<string> {
  const rpc = getRpc();
  return decompress(
    rpc,
    ownerKeypair,
    bn(lamports),
    ownerKeypair.publicKey
  );
}

export const SOL = LAMPORTS_PER_SOL;
