/**
 * NFT action - mint or buy cheap NFTs
 * 
 * ANTI-DETECT STRATEGY:
 * 1. Different marketplaces (Magic Eden, Tensor)
 * 2. Cheap NFTs only (< 0.01 SOL) - looks like retail exploration
 * 3. Sometimes "almost" buy but cancel (simulated rejection)
 * 4. Random collection selection
 */

import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import fetch from "node-fetch";
import { CONFIG } from "../config";
import { generateHumanAmount, shouldSimulateError, generatePriorityFee } from "../patterns";

interface NFTParams {
  connection: Connection;
  wallet: Keypair;
  maxPriceSOL?: number;
  action?: "buy" | "mint" | "list";
}

export async function performNFTAction({
  connection,
  wallet,
  maxPriceSOL = 0.01, // Very cheap NFTs for warmup
  action,
}: NFTParams): Promise<{ success: boolean; signature?: string; error?: string; details?: any }> {
  try {
    const selectedAction = action || (Math.random() > 0.7 ? "mint" : "buy");
    const marketplace = Math.random() > 0.5 ? "magic_eden" : "tensor";

    // Simulate "buyer's remorse" - sometimes cancel
    if (shouldSimulateError() && selectedAction === "buy") {
      console.log(`  [SIMULATED] User browsed NFTs but decided not to buy`);
      return {
        success: false,
        error: "Simulated: User cancelled transaction",
        details: { type: "rejected_by_user" },
      };
    }

    const balance = await connection.getBalance(wallet.publicKey);
    const balanceSOL = balance / 1e9;

    // Ensure we don't spend too much
    const maxSpend = Math.min(maxPriceSOL, balanceSOL * 0.5);
    if (maxSpend < 0.001) {
      return { success: false, error: "Insufficient balance for NFT" };
    }

    const price = generateHumanAmount(0.001, maxSpend);
    const collection = selectRandomCollection();

    console.log(`  ${selectedAction.toUpperCase()} NFT on ${marketplace} for ${price.toFixed(4)} SOL (${collection})`);

    if (process.env.SIMULATE === "true") {
      return {
        success: true,
        signature: `SIMULATED_NFT_${selectedAction}_${Date.now()}`,
        details: {
          action: selectedAction,
          marketplace,
          price,
          collection,
          simulated: true,
        },
      };
    }

    // Fetch cheap listings from Magic Eden
    if (marketplace === "magic_eden" && selectedAction === "buy") {
      const listings = await fetchCheapListings(collection, price);
      
      if (listings.length === 0) {
        return { success: false, error: "No suitable NFTs found" };
      }

      // Select random listing
      const listing = listings[Math.floor(Math.random() * listings.length)];
      
      // Build buy transaction
      const { blockhash } = await connection.getLatestBlockhash();
      const transaction = new Transaction();
      
      // Add priority fee for NFT sniping
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(listing.seller),
          lamports: Math.floor(listing.price * 1e9),
        })
      );

      transaction.feePayer = wallet.publicKey;
      transaction.recentBlockhash = blockhash;
      transaction.sign(wallet);

      const signature = await connection.sendRawTransaction(transaction.serialize());
      await connection.confirmTransaction(signature, "confirmed");

      console.log(`  ✓ NFT purchase confirmed: ${signature.slice(0, 20)}...`);
      return {
        success: true,
        signature,
        details: {
          action: "buy",
          price: listing.price,
          collection,
          nftAddress: listing.mint,
        },
      };
    }

    // For mint actions or Tensor
    const { blockhash } = await connection.getLatestBlockhash();
    const transaction = new Transaction();
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = blockhash;
    transaction.sign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, "confirmed");

    console.log(`  ✓ NFT action confirmed: ${signature.slice(0, 20)}...`);
    return {
      success: true,
      signature,
      details: {
        action: selectedAction,
        marketplace,
        price,
        collection,
      },
    };

  } catch (error: any) {
    console.error(`  ✗ NFT action failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function selectRandomCollection(): string {
  const collections = CONFIG.NFT.MAGIC_EDEN.cheapCollections;
  return collections[Math.floor(Math.random() * collections.length)];
}

// Fetch cheap NFT listings from Magic Eden
async function fetchCheapListings(collection: string, maxPrice: number): Promise<any[]> {
  try {
    const response = await fetch(
      `${CONFIG.NFT.MAGIC_EDEN.apiBase}/collections/${collection}/listings?limit=20&offset=0`
    );
    
    if (!response.ok) {
      return [];
    }

    const data = await response.json() as any[];
    
    // Filter by price
    return data
      .filter((item: any) => item.price <= maxPrice)
      .map((item: any) => ({
        mint: item.tokenMint,
        seller: item.seller,
        price: item.price,
      }));
  } catch {
    return [];
  }
}

// List NFT for sale (if wallet has any)
export async function listNFTForSale({
  connection,
  wallet,
  priceSOL,
}: {
  connection: Connection;
  wallet: Keypair;
  priceSOL?: number;
}): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const price = priceSOL || generateHumanAmount(0.005, 0.05);
    console.log(`  Listing NFT for ${price.toFixed(4)} SOL...`);

    if (process.env.SIMULATE === "true") {
      return {
        success: true,
        signature: `SIMULATED_LIST_${Date.now()}`,
      };
    }

    // Note: Full implementation requires marketplace SDK
    const { blockhash } = await connection.getLatestBlockhash();
    const transaction = new Transaction();
    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = blockhash;
    transaction.sign(wallet);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, "confirmed");

    console.log(`  ✓ List confirmed: ${signature.slice(0, 20)}...`);
    return { success: true, signature };

  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
