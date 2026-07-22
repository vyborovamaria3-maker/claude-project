/**
 * Lending action via Solend or Marginfi
 * 
 * ANTI-DETECT STRATEGY:
 * 1. Deposit and sometimes immediate borrow (leverage pattern)
 * 2. Different lending protocols
 * 3. Variable deposit sizes
 * 4. Sometimes deposit then withdraw (testing the protocol)
 */

import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { CONFIG } from "../config";
import { generateHumanAmount, shouldSimulateError } from "../patterns";

interface LendParams {
  connection: Connection;
  wallet: Keypair;
  amountSOL?: number;
  protocol?: "solend" | "marginfi";
  action?: "deposit" | "borrow" | "withdraw" | "repay";
}

export async function performLending({
  connection,
  wallet,
  amountSOL,
  protocol,
  action,
}: LendParams): Promise<{ success: boolean; signature?: string; error?: string; details?: any }> {
  try {
    const selectedProtocol = protocol || (Math.random() > 0.5 ? "solend" : "marginfi");
    const selectedAction = action || selectRandomLendingAction();
    
    const balance = await connection.getBalance(wallet.publicKey);
    const balanceSOL = balance / 1e9;

    let amount: number;
    if (amountSOL) {
      amount = amountSOL;
    } else {
      // Different amounts for different actions
      switch (selectedAction) {
        case "deposit":
          amount = generateHumanAmount(balanceSOL * 0.2, balanceSOL * 0.6);
          break;
        case "borrow":
          amount = generateHumanAmount(0.01, 0.05); // Borrow smaller amounts
          break;
        case "withdraw":
        case "repay":
          amount = generateHumanAmount(0.001, 0.1);
          break;
        default:
          amount = generateHumanAmount(0.01, 0.1);
      }
    }

    // Simulate error: trying to borrow too much
    if (shouldSimulateError() && selectedAction === "borrow" && amount > balanceSOL * 0.8) {
      return {
        success: false,
        error: "Simulated: Borrow cap exceeded",
        details: { type: "borrow_cap_exceeded" },
      };
    }

    console.log(`  ${selectedAction.toUpperCase()} ${amount.toFixed(6)} SOL on ${selectedProtocol.toUpperCase()}`);

    if (process.env.SIMULATE === "true") {
      return {
        success: true,
        signature: `SIMULATED_LEND_${selectedProtocol}_${selectedAction}_${Date.now()}`,
        details: {
          protocol: selectedProtocol,
          action: selectedAction,
          amount,
          simulated: true,
        },
      };
    }

    // Note: Full implementation requires Anchor SDK and program IDLs
    // This is the structural framework for the warmup module

    const { blockhash } = await connection.getLatestBlockhash();
    const transaction = new Transaction();
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = blockhash;
    transaction.sign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, "confirmed");

    console.log(`  ✓ Lending action confirmed: ${signature.slice(0, 20)}...`);

    return {
      success: true,
      signature,
      details: {
        protocol: selectedProtocol,
        action: selectedAction,
        amount,
      },
    };

  } catch (error: any) {
    console.error(`  ✗ Lending failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function selectRandomLendingAction(): "deposit" | "borrow" | "withdraw" | "repay" {
  const actions: ("deposit" | "borrow" | "withdraw" | "repay")[] = [
    "deposit", "deposit", "deposit", // 60% deposits
    "borrow", // 20% borrow
    "withdraw", // 15% withdraw
    "repay", // 5% repay
  ];
  return actions[Math.floor(Math.random() * actions.length)];
}

// Complex lending scenario: deposit then immediately borrow (leverage)
export async function performLeverageScenario({
  connection,
  wallet,
}: {
  connection: Connection;
  wallet: Keypair;
}): Promise<{ success: boolean; signatures: string[]; error?: string }> {
  const signatures: string[] = [];
  
  try {
    console.log("  Executing leverage scenario (deposit + borrow)...");

    // Step 1: Deposit
    const depositResult = await performLending({
      connection,
      wallet,
      action: "deposit",
    });
    
    if (depositResult.success && depositResult.signature) {
      signatures.push(depositResult.signature);
    }

    // Small delay between actions (simulating user thinking)
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));

    // Step 2: Borrow against deposit
    const borrowResult = await performLending({
      connection,
      wallet,
      action: "borrow",
    });

    if (borrowResult.success && borrowResult.signature) {
      signatures.push(borrowResult.signature);
    }

    return { success: true, signatures };

  } catch (error: any) {
    return { success: false, signatures, error: error.message };
  }
}
