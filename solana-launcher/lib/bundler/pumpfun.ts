// data-tag: lib.bundler.pumpfun
// Pump.fun interaction helpers for bundler (browser-safe version)

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const FEE_RECIPIENT = "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM";

export interface BuyParams {
  buyer: PublicKey;
  mint: PublicKey;
  solAmount: bigint;
  minTokensOut?: bigint;
}

export interface SellParams {
  seller: PublicKey;
  mint: PublicKey;
  tokenAmount: bigint;
  minSolOut?: bigint;
}

/**
 * Build buy instructions for Pump.fun
 * Note: Actual implementation needs Anchor IDL and program interaction
 * This is a simplified version for the bundler flow
 */
export async function buildBuyInstructions(
  connection: Connection,
  params: BuyParams
): Promise<TransactionInstruction[]> {
  const { buyer, mint, solAmount, minTokensOut = BigInt(0) } = params;

  const associatedUser = await getAssociatedTokenAddress(
    mint,
    buyer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Check if ATA exists
  const accountInfo = await connection.getAccountInfo(associatedUser);
  const instructions: TransactionInstruction[] = [];

  // Add priority fee
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Create ATA if needed
  if (!accountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        buyer,
        associatedUser,
        buyer,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Note: Actual buy instruction requires Anchor program interaction
  // This is a placeholder - real implementation needs the Pump.fun IDL
  // instructions.push(await pumpFunProgram.methods.buy(...).accounts(...).instruction())

  return instructions;
}

/**
 * Build a bundle of buy transactions
 */
export async function buildBundleBuys(
  connection: Connection,
  mint: PublicKey,
  wallets: PublicKey[],
  solAmounts: number[]
): Promise<VersionedTransaction[]> {
  const txs: VersionedTransaction[] = [];
  const latestBlockhash = await connection.getLatestBlockhash();

  for (let i = 0; i < wallets.length; i++) {
    const buyer = wallets[i];
    const solAmount = BigInt(Math.floor(solAmounts[i] * 1e9));

    const instructions = await buildBuyInstructions(connection, {
      buyer,
      mint,
      solAmount,
    });

    const message = new TransactionMessage({
      payerKey: buyer,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    txs.push(tx);
  }

  return txs;
}

/**
 * Calculate token amount for given SOL input (simplified bonding curve)
 */
export function calculateTokenAmount(
  solAmount: number,
  virtualSolReserves: number = 30,
  virtualTokenReserves: number = 1073000000
): number {
  // Simplified constant product formula
  const k = virtualSolReserves * virtualTokenReserves;
  const newSolReserves = virtualSolReserves + solAmount;
  const newTokenReserves = k / newSolReserves;
  const tokensOut = virtualTokenReserves - newTokenReserves;

  return Math.floor(tokensOut);
}

/**
 * Get bonding curve PDA
 */
export function getBondingCurvePDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    new PublicKey(PUMP_FUN_PROGRAM)
  );
  return pda;
}
