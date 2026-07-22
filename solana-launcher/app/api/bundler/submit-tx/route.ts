// data-tag: api.bundler.submit_tx
// Submit a signed transaction to the network

import { NextRequest, NextResponse } from "next/server";
import { Connection, VersionedTransaction } from "@solana/web3.js";
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

interface SubmitRequest {
  transaction: string; // base64 encoded signed transaction
  skipPreflight?: boolean;
  maxRetries?: number;
}

export async function POST(req: NextRequest) {
  try {
    const authError = await requireProdAuth(req);
    if (authError) return authError;

    const body: SubmitRequest = await req.json();
    const { transaction, skipPreflight = false, maxRetries = 2 } = body;

    if (!transaction) {
      return NextResponse.json(
        { error: "Missing transaction" },
        { status: 400 }
      );
    }

    if (typeof transaction !== "string" || transaction.length > 100_000) {
      return NextResponse.json(
        { error: "Invalid transaction payload" },
        { status: 400 }
      );
    }

    const connection = new Connection(RPC_ENDPOINT, "confirmed");

    // Deserialize transaction
    const txBuffer = Buffer.from(transaction, "base64");
    const versionedTx = VersionedTransaction.deserialize(txBuffer);

    // Send transaction
    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight,
      maxRetries: Math.min(Math.max(maxRetries, 0), 5),
      preflightCommitment: "confirmed",
    });

    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: versionedTx.message.recentBlockhash,
        lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight,
      },
      "confirmed"
    );

    if (confirmation.value.err) {
      return NextResponse.json(
        { 
          success: false, 
          signature,
          error: "Transaction failed",
          details: confirmation.value.err 
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      signature,
      url: `https://solscan.io/tx/${signature}`,
    });
  } catch (error) {
    const isDev = process.env.NODE_ENV === "development";
    const message = error instanceof Error 
      ? (isDev ? error.message : "Transaction submission failed")
      : "Transaction submission failed";
    console.error("[bundler/submit-tx] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
