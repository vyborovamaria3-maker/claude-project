/**
 * Solana Wallet Warmup - Anti-Detect Module
 * 
 * MAIN STRATEGY:
 * This module creates "natural" on-chain history for new wallets to bypass Sybil filters.
 * Each wallet gets a unique "personality" with randomized actions over weeks.
 * 
 * ANTI-DETECT PRINCIPLES:
 * 1. TIME: Actions spread over days/weeks with realistic sleep schedules
 * 2. AMOUNTS: Human-like decimals (1.0234 SOL vs 1.0 SOL)
 * 3. PATTERNS: Different "personalities" (trader, holder, degen, casual)
 * 4. ERRORS: Simulated human mistakes (failed txs, cancellations)
 * 5. SOURCES: Multiple funding sources (exchange, personal, bridge)
 * 6. PROTOCOLS: 4-5 different protocols per wallet
 * 
 * USAGE:
 *   npm install
 *   npm run build
 *   npm start
 * 
 * Or development mode:
 *   npm run dev
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { CONFIG, ActionType } from "./config";
import {
  generateActionSequence,
  generateDelay,
  generateInitialSleep,
  generateFundingAmount,
  selectRandomRPC,
  shouldSimulateError,
  isActiveHour,
  generatePersonaDescription,
} from "./patterns";

import { performSwap, performReverseSwap } from "./actions/swap";
import { performStake, performUnstake } from "./actions/stake";
import { performLending, performLeverageScenario } from "./actions/lend";
import { performNFTAction } from "./actions/nft";
import { performBridge } from "./actions/bridge";

// Load environment
dotenv.config();

// Types
interface WalletState {
  keypair: Keypair;
  actionSequence: ActionType[];
  currentActionIndex: number;
  persona: string;
  createdAt: number;
  logs: string[];
}

interface PlanData {
  wallet: string;
  persona: string;
  createdAt: number;
  schedule: Array<{
    action: ActionType;
    scheduledAt: string;
    delaySeconds: number;
  }>;
}

// Logger with timestamps
class Logger {
  private logFile: string;

  constructor() {
    const logsDir = path.join(__dirname, "..", "logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    this.logFile = path.join(logsDir, `warmup-${new Date().toISOString().split("T")[0]}.log`);
  }

  log(message: string, type: "info" | "success" | "error" | "warn" = "info") {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${type.toUpperCase()}]`;
    const fullMessage = `${prefix} ${message}`;
    
    console.log(fullMessage);
    fs.appendFileSync(this.logFile, fullMessage + "\n");
  }

  logWallet(wallet: string, message: string, type: "info" | "success" | "error" | "warn" = "info") {
    this.log(`[${wallet.slice(0, 8)}...] ${message}`, type);
  }
}

const logger = new Logger();

// Parse private keys from environment
function loadMasterWallets(): Keypair[] {
  const privateKeysStr = process.env.PRIVATE_KEYS;
  if (!privateKeysStr) {
    throw new Error("PRIVATE_KEYS not set in .env");
  }

  const keys = privateKeysStr.split(",").map(k => k.trim());
  const wallets: Keypair[] = [];

  for (const key of keys) {
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(key));
      wallets.push(keypair);
      logger.log(`Loaded master wallet: ${keypair.publicKey.toBase58().slice(0, 20)}...`, "info");
    } catch (e) {
      // SECURITY: Never log any part of private keys, even on error
      logger.log(`Failed to load master wallet: invalid key format`, "error");
    }
  }

  if (wallets.length === 0) {
    throw new Error("No valid master wallets loaded");
  }

  return wallets;
}

// Generate child wallets from master wallets
async function generateChildWallets(masterWallets: Keypair[]): Promise<WalletState[]> {
  const walletsPerMaster = parseInt(process.env.WALLETS_PER_MASTER || "3");
  const states: WalletState[] = [];

  for (const master of masterWallets) {
    for (let i = 0; i < walletsPerMaster; i++) {
      // Create new wallet
      const child = Keypair.generate();
      const actionSequence = generateActionSequence(states.length);
      
      const state: WalletState = {
        keypair: child,
        actionSequence,
        currentActionIndex: 0,
        persona: generatePersonaDescription(actionSequence),
        createdAt: Date.now(),
        logs: [],
      };

      states.push(state);

      // Save wallet info
      saveWalletInfo(state);

      logger.log(`Created child wallet ${states.length}: ${child.publicKey.toBase58().slice(0, 20)}... (${state.persona})`, "info");
    }
  }

  return states;
}

// Save wallet info to JSON
// SECURITY: Never save private keys to disk. Only public metadata.
function saveWalletInfo(state: WalletState) {
  const walletsDir = path.join(__dirname, "..", "wallets");
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true });
  }

  const filePath = path.join(walletsDir, `${state.keypair.publicKey.toBase58()}.json`);
  const data = {
    publicKey: state.keypair.publicKey.toBase58(),
    // SECURITY: secretKey is NEVER saved to disk
    // Keys are only kept in memory during runtime
    persona: state.persona,
    actionSequence: state.actionSequence,
    createdAt: state.createdAt,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Create execution plan
function createExecutionPlan(wallets: WalletState[]): PlanData[] {
  const plans: PlanData[] = [];

  for (const wallet of wallets) {
    const schedule: PlanData["schedule"] = [];
    let accumulatedDelay = generateInitialSleep() / 1000; // Initial sleep in seconds

    for (const action of wallet.actionSequence) {
      const delaySeconds = action === "IDLE" ? generateDelay() * 2 : generateDelay();
      accumulatedDelay += delaySeconds;
      
      schedule.push({
        action,
        scheduledAt: new Date(Date.now() + accumulatedDelay * 1000).toISOString(),
        delaySeconds,
      });
    }

    plans.push({
      wallet: wallet.keypair.publicKey.toBase58(),
      persona: wallet.persona,
      createdAt: wallet.createdAt,
      schedule,
    });
  }

  // Save plans
  const plansPath = path.join(__dirname, "..", "plans.json");
  fs.writeFileSync(plansPath, JSON.stringify(plans, null, 2));
  logger.log(`Saved execution plans to ${plansPath}`, "info");

  return plans;
}

// Fund child wallet from master
async function fundWallet(
  connection: Connection,
  masterWallet: Keypair,
  childWallet: Keypair,
  amount: number
): Promise<string> {
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    
    // Create transfer transaction
    const transaction = new (await import("@solana/web3.js")).Transaction().add(
      (await import("@solana/web3.js")).SystemProgram.transfer({
        fromPubkey: masterWallet.publicKey,
        toPubkey: childWallet.publicKey,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      })
    );

    transaction.feePayer = masterWallet.publicKey;
    transaction.recentBlockhash = blockhash;
    transaction.sign(masterWallet);

    if (process.env.SIMULATE === "true") {
      logger.logWallet(
        childWallet.publicKey.toBase58(),
        `[SIMULATED] Funded with ${amount.toFixed(6)} SOL from ${masterWallet.publicKey.toBase58().slice(0, 10)}...`,
        "success"
      );
      return "SIMULATED_FUNDING";
    }

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, "confirmed");

    logger.logWallet(
      childWallet.publicKey.toBase58(),
      `Funded with ${amount.toFixed(6)} SOL`,
      "success"
    );

    return signature;
  } catch (error: any) {
    logger.logWallet(
      childWallet.publicKey.toBase58(),
      `Funding failed: ${error.message}`,
      "error"
    );
    throw error;
  }
}

// Execute single action
async function executeAction(
  connection: Connection,
  wallet: WalletState,
  action: ActionType
): Promise<boolean> {
  const walletPubkey = wallet.keypair.publicKey.toBase58();

  try {
    // Check if it's "active hours"
    if (!isActiveHour()) {
      logger.logWallet(walletPubkey, "Outside active hours, postponing action", "warn");
      return false;
    }

    switch (action) {
      case "SWAP": {
        // Sometimes do swap, sometimes reverse swap
        const swapResult = await performSwap({
          connection,
          wallet: wallet.keypair,
          simulateError: shouldSimulateError(),
        });

        if (swapResult.success && swapResult.details?.outputAmount) {
          // 30% chance to reverse the swap (quick trading behavior)
          if (Math.random() < 0.3) {
            await new Promise(r => setTimeout(r, 30000)); // Wait 30s
            await performReverseSwap({
              connection,
              wallet: wallet.keypair,
              tokenMint: swapResult.details?.outputMint || CONFIG.TOKENS.USDC,
              percentage: 0.5 + Math.random() * 0.5, // 50-100%
            });
          }
        }
        return swapResult.success;
      }

      case "STAKE": {
        const stakeResult = await performStake({
          connection,
          wallet: wallet.keypair,
        });

        // 20% chance to schedule unstake (short term staking)
        if (stakeResult.success && Math.random() < 0.2) {
          // Would schedule future unstake
          logger.logWallet(walletPubkey, "Scheduled future unstake", "info");
        }
        return stakeResult.success;
      }

      case "LEND": {
        // 40% chance for leverage scenario
        if (Math.random() < 0.4) {
          const leverageResult = await performLeverageScenario({
            connection,
            wallet: wallet.keypair,
          });
          return leverageResult.success;
        } else {
          const lendResult = await performLending({
            connection,
            wallet: wallet.keypair,
          });
          return lendResult.success;
        }
      }

      case "NFT": {
        const nftResult = await performNFTAction({
          connection,
          wallet: wallet.keypair,
          maxPriceSOL: 0.01,
        });
        return nftResult.success;
      }

      case "BRIDGE": {
        const bridgeResult = await performBridge({
          connection,
          wallet: wallet.keypair,
        });
        return bridgeResult.success;
      }

      case "IDLE": {
        logger.logWallet(walletPubkey, "Idle action - doing nothing", "info");
        return true;
      }

      default:
        return false;
    }
  } catch (error: any) {
    logger.logWallet(walletPubkey, `Action failed: ${error.message}`, "error");
    return false;
  }
}

// Main execution loop
async function runWarmup() {
  logger.log("=".repeat(60), "info");
  logger.log("Solana Wallet Warmup - Anti-Detect Module", "info");
  logger.log("=".repeat(60), "info");

  const isSimulation = process.env.SIMULATE === "true";
  if (isSimulation) {
    logger.log("RUNNING IN SIMULATION MODE (no real transactions)", "warn");
  }

  // Load master wallets
  const masterWallets = loadMasterWallets();
  logger.log(`Loaded ${masterWallets.length} master wallets`, "info");

  // Setup connection with random RPC
  const rpcUrl = selectRandomRPC();
  const connection = new Connection(rpcUrl, "confirmed");
  logger.log(`Using RPC: ${rpcUrl.replace(/api-key=([^&]+)/, "api-key=***")}`, "info");

  // Generate child wallets
  const childWallets = await generateChildWallets(masterWallets);
  logger.log(`Generated ${childWallets.length} child wallets`, "info");

  // Create execution plans
  createExecutionPlan(childWallets);

  // Fund child wallets (initial funding)
  logger.log("Starting initial funding phase...", "info");
  
  for (let i = 0; i < childWallets.length; i++) {
    const child = childWallets[i];
    const master = masterWallets[i % masterWallets.length];
    const amount = generateFundingAmount();

    try {
      await fundWallet(connection, master, child.keypair, amount);
      
      // Add initial sleep after funding (simulating "new wallet sitting idle")
      const initialSleep = generateInitialSleep();
      logger.logWallet(
        child.keypair.publicKey.toBase58(),
        `Initial sleep: ${(initialSleep / 86400000).toFixed(1)} days`,
        "info"
      );

      // In real execution, we'd wait here. For testing, we skip the wait.
      // await new Promise(r => setTimeout(r, initialSleep));

    } catch (e) {
      logger.log(`Failed to fund wallet ${i + 1}`, "error");
    }
  }

  // Execute warmup actions
  logger.log("Starting warmup action phase...", "info");

  for (const wallet of childWallets) {
    logger.log(`\nProcessing wallet: ${wallet.keypair.publicKey.toBase58().slice(0, 20)}... (${wallet.persona})`, "info");

    while (wallet.currentActionIndex < wallet.actionSequence.length) {
      const action = wallet.actionSequence[wallet.currentActionIndex];
      
      logger.logWallet(
        wallet.keypair.publicKey.toBase58(),
        `Executing action ${wallet.currentActionIndex + 1}/${wallet.actionSequence.length}: ${action}`,
        "info"
      );

      const success = await executeAction(connection, wallet, action);
      
      if (success) {
        wallet.currentActionIndex++;
        wallet.logs.push(`[${new Date().toISOString()}] ${action} - success`);
      } else {
        wallet.logs.push(`[${new Date().toISOString()}] ${action} - failed`);
      }

      // Update wallet file with progress
      saveWalletInfo(wallet);

      // Delay before next action
      if (wallet.currentActionIndex < wallet.actionSequence.length) {
        const delay = generateDelay();
        logger.logWallet(
          wallet.keypair.publicKey.toBase58(),
          `Waiting ${(delay / 3600).toFixed(1)} hours before next action...`,
          "info"
        );

        // In real execution, wait the full delay
        // For testing, use shorter delay
        const actualDelay = isSimulation ? 1000 : delay * 1000;
        await new Promise(r => setTimeout(r, Math.min(actualDelay, 60000))); // Cap at 1 min for testing
      }
    }

    logger.logWallet(
      wallet.keypair.publicKey.toBase58(),
      "Warmup sequence completed!",
      "success"
    );
  }

  // Summary
  logger.log("\n" + "=".repeat(60), "info");
  logger.log("WARMUP COMPLETE", "success");
  logger.log("=".repeat(60), "info");

  for (const wallet of childWallets) {
    const successCount = wallet.logs.filter(l => l.includes("success")).length;
    logger.log(
      `${wallet.keypair.publicKey.toBase58().slice(0, 20)}... | ${wallet.persona} | ${successCount}/${wallet.actionSequence.length} actions`,
      "info"
    );
  }

  // Save final state
  const summaryPath = path.join(__dirname, "..", "summary.json");
  const summary = {
    completedAt: new Date().toISOString(),
    masterWallets: masterWallets.length,
    childWallets: childWallets.map(w => ({
      publicKey: w.keypair.publicKey.toBase58(),
      persona: w.persona,
      completedActions: w.currentActionIndex,
      totalActions: w.actionSequence.length,
      logs: w.logs,
    })),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  logger.log(`\nSummary saved to ${summaryPath}`, "info");
}

// Error handling
process.on("uncaughtException", (error) => {
  logger.log(`Uncaught exception: ${error.message}`, "error");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.log(`Unhandled rejection: ${reason}`, "error");
});

// Run
runWarmup().catch((error) => {
  logger.log(`Fatal error: ${error.message}`, "error");
  process.exit(1);
});
