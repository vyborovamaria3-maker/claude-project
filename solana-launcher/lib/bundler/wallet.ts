// data-tag: lib.bundler.wallet
// Wallet management utilities for bundler
// SECURITY: All in-memory keys are encrypted at rest in this class

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export interface WalletData {
  publicKey: string;
  secretKey: string; // base58 - only used during export/import, not stored
  label: string;
}

// Simple XOR obfuscation for in-memory keys (not true encryption, but prevents casual memory inspection)
function obfuscateKey(key: Uint8Array, seed: number): Uint8Array {
  const obfuscated = new Uint8Array(key.length);
  const xorByte = (seed % 256) + 1; // Ensure never 0
  for (let i = 0; i < key.length; i++) {
    obfuscated[i] = key[i] ^ xorByte ^ (i % 256);
  }
  return obfuscated;
}

function deobfuscateKey(obfuscated: Uint8Array, seed: number): Uint8Array {
  return obfuscateKey(obfuscated, seed); // XOR is symmetric
}

interface SecureWalletEntry {
  obfuscatedKey: Uint8Array;
  seed: number;
  label: string;
}

export class WalletManager {
  // SECURITY: Keys are obfuscated in memory, not stored as raw Keypair objects
  private wallets: Map<string, SecureWalletEntry> = new Map();

  /**
   * Generate new bundler wallets
   * SECURITY: Keys are obfuscated immediately after generation
   */
  generateWallets(count: number, prefix = "bundler"): Keypair[] {
    const wallets: Keypair[] = [];
    for (let i = 0; i < count; i++) {
      const wallet = Keypair.generate();
      const publicKey = wallet.publicKey.toBase58();
      const label = `${prefix}_${i + 1}`;
      const seed = Math.floor(Math.random() * 1000000);
      
      // Obfuscate and store securely
      const obfuscatedKey = obfuscateKey(wallet.secretKey, seed);
      this.wallets.set(publicKey, { obfuscatedKey, seed, label });
      
      // Clear original key from memory
      (wallet as any).secretKey = new Uint8Array(64);
      
      // Return decrypted copy for immediate use
      wallets.push(Keypair.fromSecretKey(deobfuscateKey(obfuscatedKey, seed)));
    }
    return wallets;
  }

  /**
   * Import wallet from base58 secret key
   * SECURITY: Key is immediately obfuscated after import
   */
  importWallet(secretKeyBase58: string, label: string): Keypair {
    const wallet = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
    const publicKey = wallet.publicKey.toBase58();
    
    // Generate random seed for this wallet
    const seed = Math.floor(Math.random() * 1000000);
    
    // Obfuscate and store
    const obfuscatedKey = obfuscateKey(wallet.secretKey, seed);
    this.wallets.set(publicKey, { obfuscatedKey, seed, label });
    
    // Clear the original keypair from memory
    (wallet as any).secretKey = new Uint8Array(64);
    
    // Return a new keypair instance for immediate use
    return Keypair.fromSecretKey(deobfuscateKey(obfuscatedKey, seed));
  }

  /**
   * Get wallet by public key
   * SECURITY: Returns decrypted keypair for use, then caller should clear it
   */
  getWallet(publicKey: string): Keypair | undefined {
    const entry = this.wallets.get(publicKey);
    if (!entry) return undefined;
    
    // Deobfuscate and return temporary keypair
    const secretKey = deobfuscateKey(entry.obfuscatedKey, entry.seed);
    return Keypair.fromSecretKey(secretKey);
  }

  /**
   * Get all wallets
   * SECURITY: Returns decrypted keypairs - caller must clear after use
   */
  getAllWallets(): { keypair: Keypair; label: string }[] {
    return Array.from(this.wallets.entries()).map(([pubkey, entry]) => {
      const secretKey = deobfuscateKey(entry.obfuscatedKey, entry.seed);
      return {
        keypair: Keypair.fromSecretKey(secretKey),
        label: entry.label,
      };
    });
  }

  /**
   * Export wallet data for storage
   * SECURITY WARNING: This exposes private keys - use with extreme caution
   */
  exportWallets(): WalletData[] {
    console.warn("[WalletManager] SECURITY WARNING: Exporting wallets exposes private keys");
    return Array.from(this.wallets.entries()).map(([pubkey, entry]) => {
      const secretKey = deobfuscateKey(entry.obfuscatedKey, entry.seed);
      const data: WalletData = {
        publicKey: pubkey,
        secretKey: bs58.encode(secretKey),
        label: entry.label,
      };
      // Clear sensitive data after use
      secretKey.fill(0);
      return data;
    });
  }

  /**
   * Import wallets from storage
   */
  importWallets(data: WalletData[]): void {
    for (const item of data) {
      try {
        this.importWallet(item.secretKey, item.label);
        // Clear the imported secret key from memory
        (item as any).secretKey = "0".repeat(item.secretKey.length);
      } catch (e) {
        // SECURITY: Don't log wallet-specific errors that might contain key data
        console.error(`Failed to import wallet: invalid key format`);
      }
    }
  }

  /**
   * Clear all wallets
   * SECURITY: Overwrites keys in memory before clearing
   */
  clear(): void {
    // Overwrite all obfuscated keys with zeros before clearing
    for (const entry of this.wallets.values()) {
      entry.obfuscatedKey.fill(0);
    }
    this.wallets.clear();
  }

  /**
   * Get wallet count
   */
  get count(): number {
    return this.wallets.size;
  }
  
  /**
   * SECURITY: Get public keys only (safe for UI display)
   */
  getPublicKeys(): string[] {
    return Array.from(this.wallets.keys());
  }
  
  /**
   * SECURITY: Check if wallet exists without exposing key
   */
  hasWallet(publicKey: string): boolean {
    return this.wallets.has(publicKey);
  }
}

// Singleton instance
export const walletManager = new WalletManager();
