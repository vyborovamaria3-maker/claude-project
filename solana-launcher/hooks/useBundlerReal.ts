"use client";
// data-tag: hooks.use_bundler_real
// Real bundler transactions using server API

import { useState, useCallback, useRef } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  TokenMetadata,
  BundlerWallet,
  BundleResult,
  BundleStatus,
  ActiveBundle,
} from "@/lib/bundler/types";

interface BundlerState {
  wallets: BundlerWallet[];
  lpWallet: Keypair | null;
  activeBundle: ActiveBundle | null;
  isLoading: boolean;
  error: string | null;
}

interface CreateTokenResult {
  success: boolean;
  mint?: string;
  transaction?: string;
  error?: string;
}

interface BuyResult {
  success: boolean;
  signature?: string;
  url?: string;
  error?: string;
}

interface AirdropResult {
  success: boolean;
  signature?: string;
  error?: string;
}

export function useBundlerReal() {
  const [state, setState] = useState<BundlerState>({
    wallets: [],
    lpWallet: null,
    activeBundle: null,
    isLoading: false,
    error: null,
  });

  const walletsRef = useRef<BundlerWallet[]>([]);
  walletsRef.current = state.wallets;

  /**
   * Generate LP wallet (token creator)
   */
  const generateLPWallet = useCallback(() => {
    const keypair = Keypair.generate();
    setState((prev) => ({ ...prev, lpWallet: keypair }));
    return keypair;
  }, []);

  /**
   * Import LP wallet from secret key
   */
  const importLPWallet = useCallback((secretKey: string) => {
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
      setState((prev) => ({ ...prev, lpWallet: keypair }));
      return keypair;
    } catch (e) {
      setState((prev) => ({ ...prev, error: "Invalid LP wallet key" }));
      return null;
    }
  }, []);

  /**
   * Generate bundler wallets
   */
  const generateWallets = useCallback((count: number) => {
    const wallets: BundlerWallet[] = [];
    for (let i = 0; i < count; i++) {
      const keypair = Keypair.generate();
      wallets.push({
        keypair,
        label: `bundler_${i + 1}`,
        solBalance: 0,
      });
    }
    setState((prev) => ({ ...prev, wallets }));
    return wallets;
  }, []);

  /**
   * Import wallet to bundler set
   */
  const importWallet = useCallback((secretKey: string, label: string) => {
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
      const wallet: BundlerWallet = {
        keypair,
        label,
        solBalance: 0,
      };
      setState((prev) => ({
        ...prev,
        wallets: [...prev.wallets, wallet],
      }));
      return wallet;
    } catch {
      return null;
    }
  }, []);

  /**
   * Clear all wallets
   */
  const clearWallets = useCallback(() => {
    setState((prev) => ({ ...prev, wallets: [], lpWallet: null }));
  }, []);

  /**
   * Create token with real transaction
   */
  const createToken = useCallback(
    async (metadata: TokenMetadata): Promise<CreateTokenResult> => {
      if (!state.lpWallet) {
        return { success: false, error: "LP wallet not set" };
      }

      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      try {
        const response = await fetch("/api/bundler/create-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: metadata.name,
            symbol: metadata.symbol,
            description: metadata.description,
            image: metadata.image,
            twitter: metadata.twitter,
            telegram: metadata.telegram,
            website: metadata.website,
            creatorSecretKey: bs58.encode(state.lpWallet.secretKey),
            priorityFee: 0.00002,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to create token");
        }

        setState((prev) => ({ ...prev, isLoading: false }));
        return {
          success: true,
          mint: data.mint,
          transaction: data.transaction,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        setState((prev) => ({ ...prev, isLoading: false, error: message }));
        return { success: false, error: message };
      }
    },
    [state.lpWallet]
  );

  /**
   * Submit transaction to network
   */
  const submitTransaction = useCallback(async (transaction: string): Promise<BuyResult> => {
    try {
      const response = await fetch("/api/bundler/submit-tx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction,
          skipPreflight: true,
          maxRetries: 3,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to submit transaction");
      }

      return {
        success: true,
        signature: data.signature,
        url: data.url,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  }, []);

  /**
   * Buy tokens with specific wallet
   */
  const buyTokens = useCallback(
    async (mint: string, walletIndex: number, solAmount: number): Promise<BuyResult> => {
      const wallet = state.wallets[walletIndex];
      if (!wallet) {
        return { success: false, error: "Wallet not found" };
      }

      setState((prev) => ({ ...prev, isLoading: true, error: null }));

      try {
        const response = await fetch("/api/bundler/buy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mint,
            buyerSecretKey: bs58.encode(wallet.keypair.secretKey),
            solAmount,
            slippageBps: 500,
            priorityFee: 0.00002,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to create buy transaction");
        }

        // Submit the transaction
        const submitResult = await submitTransaction(data.transaction);

        setState((prev) => ({ ...prev, isLoading: false }));
        return submitResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        setState((prev) => ({ ...prev, isLoading: false, error: message }));
        return { success: false, error: message };
      }
    },
    [state.wallets, submitTransaction]
  );

  /**
   * Execute bundle buys across all wallets
   */
  const executeBundleBuys = useCallback(
    async (mint: string, solAmounts: number[]): Promise<BundleResult> => {
      if (state.wallets.length === 0) {
        return { success: false, error: "No bundler wallets" };
      }

      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
        activeBundle: {
          id: Math.random().toString(36).slice(2),
          status: "sending" as BundleStatus,
          config: {} as any,
          progress: 0,
          results: [],
          logs: ["Starting bundle buys..."],
        },
      }));

      const results: BuyResult[] = [];

      for (let i = 0; i < state.wallets.length && i < solAmounts.length; i++) {
        setState((prev) => ({
          ...prev,
          activeBundle: prev.activeBundle
            ? {
                ...prev.activeBundle,
                progress: (i / state.wallets.length) * 100,
                logs: [...prev.activeBundle.logs, `Buying with wallet ${i + 1}...`],
              }
            : null,
        }));

        const result = await buyTokens(mint, i, solAmounts[i]);
        results.push(result);

        // Small delay between buys
        if (i < state.wallets.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const allSuccess = results.every((r) => r.success);

      setState((prev) => ({
        ...prev,
        isLoading: false,
        activeBundle: prev.activeBundle
          ? {
              ...prev.activeBundle,
              status: allSuccess ? "confirmed" : "failed",
              progress: 100,
              logs: [
                ...prev.activeBundle.logs,
                allSuccess ? "All buys completed!" : "Some buys failed",
              ],
            }
          : null,
      }));

      return {
        success: allSuccess,
        signature: results.find((r) => r.signature)?.signature,
      };
    },
    [state.wallets, buyTokens]
  );

  /**
   * Full launch: create token + bundle buys
   */
  const launchWithBundle = useCallback(
    async (metadata: TokenMetadata, buyAmounts: number[]): Promise<BundleResult> => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
        activeBundle: {
          id: Math.random().toString(36).slice(2),
          status: "pending" as BundleStatus,
          config: {} as any,
          progress: 0,
          results: [],
          logs: ["Creating token..."],
        },
      }));

      // Step 1: Create token
      const createResult = await createToken(metadata);
      if (!createResult.success || !createResult.transaction) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: createResult.error || "Token creation failed",
        }));
        return { success: false, error: createResult.error };
      }

      // Submit token creation
      const submitResult = await submitTransaction(createResult.transaction);
      if (!submitResult.success) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: submitResult.error || "Failed to submit token creation",
        }));
        return { success: false, error: submitResult.error };
      }

      const mint = createResult.mint!;

      setState((prev) => ({
        ...prev,
        activeBundle: prev.activeBundle
          ? {
              ...prev.activeBundle,
              logs: [...prev.activeBundle.logs, `Token created: ${mint}`, "Waiting for confirmation..."],
            }
          : null,
      }));

      // Wait for token to be confirmed
      await new Promise((r) => setTimeout(r, 5000));

      // Step 2: Execute bundle buys
      const buyResult = await executeBundleBuys(mint, buyAmounts);

      return {
        success: buyResult.success,
        mint,
        signature: submitResult.signature,
      };
    },
    [createToken, submitTransaction, executeBundleBuys]
  );

  return {
    wallets: state.wallets,
    lpWallet: state.lpWallet,
    activeBundle: state.activeBundle,
    isLoading: state.isLoading,
    error: state.error,
    generateLPWallet,
    importLPWallet,
    generateWallets,
    importWallet,
    clearWallets,
    createToken,
    submitTransaction,
    buyTokens,
    executeBundleBuys,
    launchWithBundle,
    requestAirdrop,
  };

  /**
   * Request devnet airdrop for testing
   */
  async function requestAirdrop(publicKey: string, amount: number = 2): Promise<AirdropResult> {
    try {
      const response = await fetch("/api/bundler/airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey, amount }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Airdrop failed");
      }

      return { success: true, signature: data.signature };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  }
}
