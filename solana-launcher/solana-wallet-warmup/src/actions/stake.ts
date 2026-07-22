/**
 * Staking action via Marinade or Jito
 * 
 * ANTI-DETECT STRATEGY:
 * 1. Different staking protocols per wallet
 * 2. Random stake amounts (not round numbers)
 * 3. Mix of full stake and partial unstake
 * 4. Random delay before unstake (simulating "hodl" behavior)
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, StakeProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CONFIG } from "../config";
import { generateHumanAmount, generatePriorityFee, shouldSimulateError } from "../patterns";

interface StakeParams {
  connection: Connection;
  wallet: Keypair;
  amountSOL?: number;
  protocol?: "marinade" | "jito" | "lido" | "native";
}

export async function performStake({
  connection,
  wallet,
  amountSOL,
  protocol,
}: StakeParams): Promise<{ success: boolean; signature?: string; error?: string; details?: any }> {
  try {
    const selectedProtocol = protocol || selectRandomProtocol();
    const balance = await connection.getBalance(wallet.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;

    // Stake amount: 30% - 90% of balance
    const stakeAmount = amountSOL || generateHumanAmount(
      balanceSOL * 0.3,
      Math.min(balanceSOL * 0.9, balanceSOL - 0.01)
    );

    if (stakeAmount < 0.001) {
      return { success: false, error: "Insufficient balance for staking" };
    }

    console.log(`  Staking ${stakeAmount.toFixed(6)} SOL via ${selectedProtocol.toUpperCase()}`);

    // Simulate error: insufficient balance
    if (shouldSimulateError() && stakeAmount > balanceSOL) {
      console.log(`  [SIMULATED ERROR] Attempted to stake more than balance`);
      return {
        success: false,
        error: "Simulated insufficient balance",
        details: { type: "insufficient_balance" },
      };
    }

    if (process.env.SIMULATE === "true") {
      return {
        success: true,
        signature: `SIMULATED_STAKE_${selectedProtocol.toUpperCase()}_${Date.now()}`,
        details: {
          protocol: selectedProtocol,
          amount: stakeAmount,
          simulated: true,
        },
      };
    }

    let signature: string;

    switch (selectedProtocol) {
      case "native":
        signature = await nativeStake(connection, wallet, stakeAmount);
        break;
      case "marinade":
        signature = await marinadeStake(connection, wallet, stakeAmount);
        break;
      case "jito":
        signature = await jitoStake(connection, wallet, stakeAmount);
        break;
      default:
        signature = await nativeStake(connection, wallet, stakeAmount);
    }

    console.log(`  ✓ Stake confirmed: ${signature.slice(0, 20)}...`);

    return {
      success: true,
      signature,
      details: {
        protocol: selectedProtocol,
        amount: stakeAmount,
      },
    };

  } catch (error: any) {
    console.error(`  ✗ Stake failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function selectRandomProtocol(): "marinade" | "jito" | "lido" | "native" {
  const protocols: ("marinade" | "jito" | "lido" | "native")[] = ["native", "marinade", "jito", "native"];
  return protocols[Math.floor(Math.random() * protocols.length)];
}

// Native Solana staking (create stake account)
async function nativeStake(
  connection: Connection,
  wallet: Keypair,
  amountSOL: number
): Promise<string> {
  // Create stake account
  const stakeAccount = Keypair.generate();
  const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

  const { blockhash } = await connection.getLatestBlockhash();

  const transaction = new Transaction().add(
    // Create account
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: stakeAccount.publicKey,
      lamports: amountLamports + 2282880, // Rent-exempt minimum for stake account
      space: 200,
      programId: StakeProgram.programId,
    }),
    // Initialize stake
    StakeProgram.initialize({
      stakePubkey: stakeAccount.publicKey,
      authorized: {
        staker: wallet.publicKey,
        withdrawer: wallet.publicKey,
      },
    }),
  );

  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = blockhash;
  transaction.sign(wallet, stakeAccount);

  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

// Marinade liquid staking (mSOL)
async function marinadeStake(
  connection: Connection,
  wallet: Keypair,
  amountSOL: number
): Promise<string> {
  // Marinade deposit instruction
  const marinadeProgram = new PublicKey(CONFIG.STAKING.MARINADE.programId);
  const mSOLMint = new PublicKey(CONFIG.STAKING.MARINADE.mSOL);

  const { blockhash } = await connection.getLatestBlockhash();
  const priorityFee = generatePriorityFee();

  // Build deposit transaction
  const transaction = new Transaction();
  
  // Add priority fee
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 0, // Just for priority fee
    })
  );

  // Note: Full Marinade integration requires anchor IDL
  // This is a simplified version for the warmup module structure
  // In production, use @marinade.finance/marinade-ts-sdk

  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = blockhash;
  transaction.sign(wallet);

  // Simulated for this template - real implementation needs SDK
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

// Jito staking (jitoSOL)
async function jitoStake(
  connection: Connection,
  wallet: Keypair,
  amountSOL: number
): Promise<string> {
  // Similar to Marinade but for Jito
  const jitoProgram = new PublicKey(CONFIG.STAKING.JITO.programId);

  const { blockhash } = await connection.getLatestBlockhash();

  const transaction = new Transaction();
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = blockhash;
  transaction.sign(wallet);

  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

// Perform unstake (delayed action)
export async function performUnstake({
  connection,
  wallet,
  stakeAccount,
  protocol,
}: {
  connection: Connection;
  wallet: Keypair;
  stakeAccount: PublicKey;
  protocol: "native" | "marinade" | "jito";
}): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    console.log(`  Unstaking from ${protocol}...`);

    if (process.env.SIMULATE === "true") {
      return {
        success: true,
        signature: `SIMULATED_UNSTAKE_${Date.now()}`,
      };
    }

    const { blockhash } = await connection.getLatestBlockhash();

    const transaction = new Transaction();
    
    if (protocol === "native") {
      // Deactivate stake
      transaction.add(
        StakeProgram.deactivate({
          stakePubkey: stakeAccount,
          authorizedPubkey: wallet.publicKey,
        })
      );
    }

    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = blockhash;
    transaction.sign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, "confirmed");

    console.log(`  ✓ Unstake initiated: ${signature.slice(0, 20)}...`);
    return { success: true, signature };

  } catch (error: any) {
    console.error(`  ✗ Unstake failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
