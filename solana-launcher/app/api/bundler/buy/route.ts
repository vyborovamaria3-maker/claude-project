// data-tag: api.bundler.buy
// Server-side buy transaction builder

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_IDL,
  FEE_RECIPIENT,
  DEFAULT_VIRTUAL_SOL_RESERVES,
  DEFAULT_VIRTUAL_TOKEN_RESERVES,
  DEFAULT_FEE_BASIS_POINTS,
} from "@/lib/bundler/idl";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 10; // requests per window (more strict for financial operations)
const RATE_LIMIT_WINDOW = 60; // seconds

const RPC_ENDPOINT = process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";

interface BuyRequest {
  mint: string;
  buyerPublicKey: string; // base58 public key only - NO PRIVATE KEY
  solAmount: number; // SOL amount
  slippageBps?: number; // basis points (default 500 = 5%)
  priorityFee?: number; // SOL
}

// Calculate tokens received for SOL input using bonding curve
function calculateTokensForSol(
  solAmount: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  feeBasisPoints: bigint
): bigint {
  // k = x * y (constant product)
  const k = virtualSolReserves * virtualTokenReserves;
  
  // Fee calculation
  const fee = (solAmount * feeBasisPoints) / 10000n;
  const effectiveSol = solAmount - fee;
  
  // New reserves after buy
  const newSolReserves = virtualSolReserves + effectiveSol;
  const newTokenReserves = k / newSolReserves;
  
  // Tokens received
  const tokensOut = virtualTokenReserves - newTokenReserves;
  
  return tokensOut;
}

export async function POST(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  // Check rate limit
  const clientIp = getClientIp(req as unknown as Request);
  const rateLimit = checkRateLimit(clientIp, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later.", retryAfter: rateLimit.retryAfter },
      { 
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimit.limit),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.reset),
          "Retry-After": String(rateLimit.retryAfter || 60),
        }
      }
    );
  }
  
  try {
    const body: BuyRequest = await req.json();
    const { mint, buyerPublicKey, solAmount, slippageBps = 500, priorityFee = 0.00002 } = body;


    if (!mint || !buyerPublicKey || !solAmount) {
      return NextResponse.json(
        { error: "Missing required fields: mint, buyerPublicKey, solAmount" },
        { status: 400 }
      );
    }

    if (!Number.isFinite(solAmount) || solAmount <= 0 || solAmount > 10) {
      return NextResponse.json(
        { error: "solAmount must be a finite value between 0 and 10 SOL" },
        { status: 400 }
      );
    }

    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 2_000) {
      return NextResponse.json(
        { error: "slippageBps must be between 0 and 2000" },
        { status: 400 }
      );
    }

    if (!Number.isFinite(priorityFee) || priorityFee < 0 || priorityFee > 0.05) {
      return NextResponse.json(
        { error: "priorityFee must be between 0 and 0.05 SOL" },
        { status: 400 }
      );
    }
    
    // Validate public key format (base58, 32-44 chars, Solana address)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!base58Regex.test(buyerPublicKey)) {
      return NextResponse.json(
        { error: "Invalid buyerPublicKey format. Must be a valid Solana base58 public key." },
        { status: 400 }
      );
    }

    const connection = new Connection(RPC_ENDPOINT, "confirmed");
    const mintPubkey = new PublicKey(mint);
    const buyerPubkey = new PublicKey(buyerPublicKey);

    // Check buyer balance
    const buyerBalance = await connection.getBalance(buyerPubkey);
    const solLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
    const totalRequired = solLamports + BigInt(Math.floor(priorityFee * LAMPORTS_PER_SOL));
    
    if (buyerBalance < Number(totalRequired)) {
      return NextResponse.json(
        { error: `Insufficient SOL balance (need ${solAmount + priorityFee} SOL)` },
        { status: 400 }
      );
    }

    // Setup provider with read-only capabilities
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: buyerPubkey,
        signTransaction: async (tx) => tx,
        signAllTransactions: async (txs) => txs,
      },
      { commitment: "confirmed" }
    );

    const program = new Program(PUMP_FUN_IDL as any, provider) as any;

    // Derive accounts
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );

    const [globalPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );

    const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );

    const associatedBondingCurve = getAssociatedTokenAddressSync(mintPubkey, bondingCurvePda, true);
    const associatedUser = getAssociatedTokenAddressSync(mintPubkey, buyerPubkey);

    // Calculate expected tokens
    const expectedTokens = calculateTokensForSol(
      solLamports,
      BigInt(DEFAULT_VIRTUAL_SOL_RESERVES),
      BigInt(DEFAULT_VIRTUAL_TOKEN_RESERVES),
      BigInt(DEFAULT_FEE_BASIS_POINTS)
    );

    // Apply slippage to max SOL cost
    const maxSolCost = (solLamports * BigInt(10000 + slippageBps)) / 10000n;

    // Check if ATA exists
    let needsAta = false;
    try {
      await getAccount(connection, associatedUser);
    } catch {
      needsAta = true;
    }

    // Build transaction
    const latestBlockhash = await connection.getLatestBlockhash();
    const priorityFeeLamports = Math.floor(priorityFee * LAMPORTS_PER_SOL);
    const computeUnitPrice = Math.floor((priorityFeeLamports / 500000) * 1e6);

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }),
    ];

    // Add ATA creation if needed
    if (needsAta) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          buyerPubkey,
          associatedUser,
          buyerPubkey,
          mintPubkey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    // Add buy instruction
    const buyIx = await program.methods
      .buy(new BN(expectedTokens.toString()), new BN(maxSolCost.toString()), new BN(slippageBps))
      .accounts({
        global: globalPda,
        feeRecipient: new PublicKey(FEE_RECIPIENT),
        mint: mintPubkey,
        bondingCurve: bondingCurvePda,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: buyerPubkey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        eventAuthority: eventAuthorityPda,
        program: new PublicKey(PUMP_FUN_PROGRAM_ID),
      })
      .instruction();

    instructions.push(buyIx);

    const message = new TransactionMessage({
      payerKey: buyerPubkey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    // DO NOT sign on server - client must sign with their private key
    const serializedTx = Buffer.from(transaction.serialize()).toString("base64");

    return NextResponse.json({
      success: true,
      mint: mint,
      buyer: buyerPubkey.toBase58(),
      solAmount: solAmount,
      expectedTokens: expectedTokens.toString(),
      unsignedTransaction: serializedTx,
      message: "Buy transaction prepared. Sign with your wallet and submit.",
      requiresSigning: true,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === "development";
    const message = error instanceof Error 
      ? (isDev ? error.message : "Internal server error")
      : "Internal server error";
    console.error("[bundler/buy] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
