// data-tag: api.bundler.create_token
// Server-side token creation with Anchor (real transactions)

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
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
} from "@solana/spl-token";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  PUMP_FUN_PROGRAM_ID,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  PUMP_FUN_IDL,
  FEE_RECIPIENT,
} from "@/lib/bundler/idl";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_ENDPOINT =
  process.env.HELIUS_RPC_URL ||
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
  process.env.QUICKNODE_RPC_URL ||
  process.env.NEXT_PUBLIC_QUICKNODE_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

interface CreateTokenRequest {
  name: string;
  symbol: string;
  description: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  creatorPublicKey: string;
  mintPublicKey: string;
  priorityFee?: number; // SOL
}

export async function POST(req: NextRequest) {
  try {
    const authError = await requireProdAuth(req);
    if (authError) return authError;

    const body: CreateTokenRequest = await req.json();
    const { name, symbol, creatorPublicKey, mintPublicKey, priorityFee = 0.00002 } = body;


    if (!name || !symbol || !creatorPublicKey || !mintPublicKey) {
      return NextResponse.json(
        { error: "Missing required fields: name, symbol, creatorPublicKey, mintPublicKey" },
        { status: 400 }
      );
    }

    if (name.length > 32 || symbol.length > 10) {
      return NextResponse.json(
        { error: "Invalid token metadata length" },
        { status: 400 }
      );
    }

    if (!Number.isFinite(priorityFee) || priorityFee < 0 || priorityFee > 0.1) {
      return NextResponse.json(
        { error: "priorityFee must be between 0 and 0.1 SOL" },
        { status: 400 }
      );
    }

    // Initialize connection and provider
    const connection = new Connection(RPC_ENDPOINT, "confirmed");

    let creatorPubkey: PublicKey;
    let mintPubkey: PublicKey;
    try {
      creatorPubkey = new PublicKey(creatorPublicKey);
      mintPubkey = new PublicKey(mintPublicKey);
    } catch {
      return NextResponse.json(
        { error: "Invalid public key format" },
        { status: 400 }
      );
    }

    // Check creator balance
    const creatorBalance = await connection.getBalance(creatorPubkey);
    if (creatorBalance < 0.05 * LAMPORTS_PER_SOL) {
      return NextResponse.json(
        { error: "Insufficient SOL balance (need at least 0.05 SOL)" },
        { status: 400 }
      );
    }

    // Setup Anchor provider
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: creatorPubkey,
        signTransaction: async (tx) => tx,
        signAllTransactions: async (txs) => txs,
      },
      { commitment: "confirmed" }
    );

    // Initialize program
    const program = new Program(PUMP_FUN_IDL as any, provider) as any;

    // Derive PDAs
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );

    const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint-authority")],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );

    const associatedBondingCurve = getAssociatedTokenAddressSync(
      mintPubkey,
      bondingCurvePda,
      true
    );

    const associatedUser = getAssociatedTokenAddressSync(
      mintPubkey,
      creatorPubkey
    );

    const [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID).toBuffer(),
        mintPubkey.toBuffer(),
      ],
      new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID)
    );

    const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );

    const [globalPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );

    // Build metadata URI (simplified - in production use IPFS)
    const metadataUri = `https://pump.fun/metadata/${mintPubkey.toBase58()}`;

    // Build transaction
    const latestBlockhash = await connection.getLatestBlockhash();

    const priorityFeeLamports = Math.floor(priorityFee * LAMPORTS_PER_SOL);
    const computeUnitPrice = Math.floor((priorityFeeLamports / 500000) * 1e6);

    // Get create instruction
    const createIx = await program.methods
      .create(name, symbol, metadataUri, creatorPubkey)
      .accounts({
        mint: mintPubkey,
        mintAuthority: mintAuthorityPda,
        bondingCurve: bondingCurvePda,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: creatorPubkey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID),
        metadata: metadataPda,
        rent: SystemProgram.programId,
        eventAuthority: eventAuthorityPda,
        program: new PublicKey(PUMP_FUN_PROGRAM_ID),
      })
      .instruction();

    const message = new TransactionMessage({
      payerKey: creatorPubkey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }),
        createIx,
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);

    // Serialize for client; signing happens locally in the browser.
    const serializedTx = Buffer.from(transaction.serialize()).toString("base64");

    return NextResponse.json({
      success: true,
      mint: mintPubkey.toBase58(),
      bondingCurve: bondingCurvePda.toBase58(),
      creator: creatorPubkey.toBase58(),
      transaction: serializedTx,
      message: "Token transaction prepared. Sign locally before submission.",
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === "development";
    const message = error instanceof Error 
      ? (isDev ? error.message : "Internal server error")
      : "Internal server error";
    console.error("[bundler/create-token] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
