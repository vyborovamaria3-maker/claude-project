/**
 * Swap action using Jupiter API
 * 
 * ANTI-DETECT STRATEGY:
 * 1. Random slippage (0.5% - 3%) - bots use fixed slippage
 * 2. Random token pairs - not just SOL-USDC, but also RAY, ORCA, BONK
 * 3. Random amounts with human-like decimals
 * 4. Sometimes fail with slippage (simulating market volatility reaction)
 */

import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import fetch from "node-fetch";
import { CONFIG } from "../config";
import { generateHumanAmount, generatePriorityFee, shouldSimulateError, getRandomErrorType } from "../patterns";

const JUPITER_API = CONFIG.DEX.JUPITER.apiBase;

interface SwapParams {
  connection: Connection;
  wallet: Keypair;
  amountSOL?: number;
  targetToken?: string;
  simulateError?: boolean;
}

export async function performSwap({
  connection,
  wallet,
  amountSOL,
  targetToken,
  simulateError = false,
}: SwapParams): Promise<{ success: boolean; signature?: string; error?: string; details?: any }> {
  try {
    // Get wallet SOL balance
    const balance = await connection.getBalance(wallet.publicKey);
    const balanceSOL = balance / 1e9;

    // Determine swap amount
    let swapAmount: number;
    if (amountSOL) {
      swapAmount = amountSOL;
    } else {
      // Random amount: 10% - 80% of balance, but keep at least 0.01 SOL for fees
      const maxSwap = Math.max(0, balanceSOL - 0.01);
      const percentage = Math.random() * 0.7 + 0.1; // 10% - 80%
      swapAmount = generateHumanAmount(0.001, maxSwap * percentage);
    }

    // Ensure we have enough balance
    if (swapAmount <= 0.001 || swapAmount > balanceSOL - 0.005) {
      return {
        success: false,
        error: `Insufficient balance: ${balanceSOL.toFixed(4)} SOL, attempted: ${swapAmount.toFixed(6)} SOL`,
      };
    }

    const inputMint = CONFIG.TOKENS.SOL;
    const outputMint = targetToken || selectRandomOutputToken();
    const slippageBps = CONFIG.DEX.JUPITER.slippageBps();

    // Simulate human error: sometimes set slippage too low
    if (shouldSimulateError() && simulateError) {
      const errorType = getRandomErrorType();
      if (errorType === "slippage_exceeded") {
        console.log("  [SIMULATED ERROR] Slippage set too low (0.1%), transaction would fail");
        return {
          success: false,
          error: "Simulated slippage error",
          details: { type: "slippage_exceeded", attemptedSlippage: 10 },
        };
      }
    }

    const amountLamports = Math.floor(swapAmount * 1e9);

    console.log(`  Swapping ${swapAmount.toFixed(6)} SOL → ${outputMint.slice(0, 8)}... (slippage: ${slippageBps / 100}%)`);

    // Check if simulation mode
    if (process.env.SIMULATE === "true") {
      console.log(`  [SIMULATION] Swap would execute: ${swapAmount.toFixed(6)} SOL with ${slippageBps / 100}% slippage`);
      return {
        success: true,
        signature: "SIMULATED_SWAP_SIGNATURE_" + Date.now(),
        details: {
          inputAmount: swapAmount,
          slippageBps,
          inputMint,
          outputMint,
          simulated: true,
        },
      };
    }

    // Get quote from Jupiter
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const quoteResponse = await fetch(quoteUrl);
    
    if (!quoteResponse.ok) {
      throw new Error(`Quote failed: ${quoteResponse.statusText}`);
    }

    const quoteData = await quoteResponse.json() as any;

    // Get swap transaction
    const swapUrl = `${JUPITER_API}/swap`;
    const swapResponse = await fetch(swapUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        priorityFeeLamports: generatePriorityFee(),
      }),
    });

    if (!swapResponse.ok) {
      throw new Error(`Swap preparation failed: ${swapResponse.statusText}`);
    }

    const { swapTransaction } = await swapResponse.json() as any;

    // Deserialize and sign transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Sign with wallet
    transaction.sign([wallet]);

    // Send transaction
    const signature = await connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: false,
    });

    // Wait for confirmation
    await connection.confirmTransaction(signature, "confirmed");

    console.log(`  ✓ Swap confirmed: ${signature.slice(0, 20)}...`);

    return {
      success: true,
      signature,
      details: {
        inputAmount: swapAmount,
        outputAmount: quoteData.outAmount / 1e6, // USDC has 6 decimals
        slippageBps,
        priceImpact: quoteData.priceImpactPct,
      },
    };

  } catch (error: any) {
    console.error(`  ✗ Swap failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}

function selectRandomOutputToken(): string {
  const tokens = [
    CONFIG.TOKENS.USDC,   // Most common - 40%
    CONFIG.TOKENS.USDC,
    CONFIG.TOKENS.RAY,    // 20%
    CONFIG.TOKENS.ORCA,   // 20%
    CONFIG.TOKENS.JUP,    // 10%
    CONFIG.TOKENS.BONK,   // 10%
  ];
  return tokens[Math.floor(Math.random() * tokens.length)];
}

// Perform reverse swap (token back to SOL)
export async function performReverseSwap({
  connection,
  wallet,
  tokenMint,
  percentage = 1.0, // 100% by default
}: {
  connection: Connection;
  wallet: Keypair;
  tokenMint: string;
  percentage?: number;
}): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    // Get token account balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(tokenMint) }
    );

    if (tokenAccounts.value.length === 0) {
      return { success: false, error: "No token balance found" };
    }

    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    const swapAmount = Math.floor(balance * percentage * 1e6); // USDC has 6 decimals

    if (swapAmount < 1000) { // Less than 0.001 USDC
      return { success: false, error: "Insufficient token balance" };
    }

    const slippageBps = CONFIG.DEX.JUPITER.slippageBps();

    console.log(`  Reverse swapping ${(swapAmount / 1e6).toFixed(4)} token → SOL`);

    if (process.env.SIMULATE === "true") {
      return {
        success: true,
        signature: "SIMULATED_REVERSE_SWAP_" + Date.now(),
      };
    }

    // Get quote
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${tokenMint}&outputMint=${CONFIG.TOKENS.SOL}&amount=${swapAmount}&slippageBps=${slippageBps}`;
    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json() as any;

    // Get swap transaction
    const swapResponse = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        priorityFeeLamports: generatePriorityFee(),
      }),
    });

    const { swapTransaction } = await swapResponse.json() as any;
    const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    transaction.sign([wallet]);

    const signature = await connection.sendTransaction(transaction);
    await connection.confirmTransaction(signature, "confirmed");

    console.log(`  ✓ Reverse swap confirmed: ${signature.slice(0, 20)}...`);
    return { success: true, signature };

  } catch (error: any) {
    console.error(`  ✗ Reverse swap failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
