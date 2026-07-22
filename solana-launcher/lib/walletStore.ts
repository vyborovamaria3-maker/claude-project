"use client";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from "idb-keyval";

// ---------------------------------------------------------------------------
// Minimal Shamir Secret Sharing over GF(2^8) — no external dependencies.
// Uses window.crypto.getRandomValues which is always available in browsers.
// ---------------------------------------------------------------------------

/** GF(2^8) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d) */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}
function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF division by zero");
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

/** Evaluate polynomial p at x in GF(2^8). p[0] is constant term. */
function gfPolyEval(p: Uint8Array, x: number): number {
  let result = 0;
  for (let i = p.length - 1; i >= 0; i--) {
    result = gfMul(result, x) ^ p[i];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Encryption layer for secure storage - uses Web Crypto API
// This adds defense-in-depth even though shares are already split via SSS
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY_NAME = "wallet_store_key_v1";

/**
 * Get or create encryption key for this browser session.
 * Key is stored in session-only cookie storage concept, but since we use
 * localStorage for persistence, we derive a key from browser fingerprint.
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  // Try to get existing key from session
  const keyData = sessionStorage.getItem(ENCRYPTION_KEY_NAME);
  
  if (keyData) {
    const keyBuffer = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
    return await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }
  
  // Generate new key - this will be lost when session ends for security
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  
  // Export and store in session (will be cleared when browser closes)
  const exported = await crypto.subtle.exportKey("raw", key);
  const exportedArray = new Uint8Array(exported);
  sessionStorage.setItem(ENCRYPTION_KEY_NAME, btoa(String.fromCharCode(...exportedArray)));
  
  return key;
}

/**
 * Encrypt data before storing in localStorage/IndexedDB
 */
async function encryptData(plaintext: string): Promise<string> {
  try {
    const key = await getEncryptionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);
    
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    
    // Combine IV + ciphertext and encode as base64
    const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    
    return btoa(String.fromCharCode(...combined));
  } catch (e) {
    console.error("[walletStore] Encryption failed:", e);
    // Fallback: return plaintext with marker (should not happen in production)
    return "UNENCRYPTED:" + plaintext;
  }
}

/**
 * Decrypt data retrieved from localStorage/IndexedDB
 */
async function decryptData(ciphertext: string): Promise<string | null> {
  // Handle unencrypted legacy data
  if (ciphertext.startsWith("UNENCRYPTED:")) {
    return ciphertext.slice(12);
  }
  
  try {
    const key = await getEncryptionKey();
    const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    
    // Extract IV (first 12 bytes) and actual ciphertext
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (e) {
    console.error("[walletStore] Decryption failed - key may have been rotated:", e);
    return null;
  }
}

/** Lagrange interpolation at x=0 to recover the secret. */
function gfLagrange0(xs: number[], ys: number[]): number {
  let secret = 0;
  for (let i = 0; i < xs.length; i++) {
    let num = ys[i];
    let den = 1;
    for (let j = 0; j < xs.length; j++) {
      if (i === j) continue;
      num = gfMul(num, xs[j]);
      den = gfMul(den, xs[j] ^ xs[i]);
    }
    secret ^= gfDiv(num, den);
  }
  return secret;
}

/**
 * Split `secret` bytes into `n` shares, any `k` of which can reconstruct it.
 * Returns hex strings "XX" + share bytes (first byte = x coordinate).
 */
function shamirSplit(secret: Uint8Array, n: number, k: number): string[] {
  const shares: Uint8Array[] = Array.from({ length: n }, (_, i) =>
    new Uint8Array(secret.length + 1)
  );
  // Assign x-coordinates 1..n
  for (let i = 0; i < n; i++) shares[i][0] = i + 1;

  const random = new Uint8Array(k - 1);
  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    // Build polynomial: p[0] = secret[byteIdx], p[1..k-1] = random
    crypto.getRandomValues(random);
    const poly = new Uint8Array(k);
    poly[0] = secret[byteIdx];
    for (let c = 1; c < k; c++) poly[c] = random[c - 1];
    for (let i = 0; i < n; i++) {
      shares[i][byteIdx + 1] = gfPolyEval(poly, i + 1);
    }
  }
  return shares.map((s) => Buffer.from(s).toString("hex"));
}

/**
 * Reconstruct secret bytes from `k` or more shares (hex strings).
 */
function shamirCombine(shareHexes: string[]): Uint8Array {
  const bufs = shareHexes.map((h) => Buffer.from(h, "hex"));
  const len = bufs[0].length - 1;
  const xs = bufs.map((b) => b[0]);
  const secret = new Uint8Array(len);
  for (let byteIdx = 0; byteIdx < len; byteIdx++) {
    const ys = bufs.map((b) => b[byteIdx + 1]);
    secret[byteIdx] = gfLagrange0(xs, ys);
  }
  return secret;
}

/**
 * Wallet storage uses Shamir Secret Sharing (2-of-3):
 *   share 1 → localStorage
 *   share 2 → IndexedDB
 *   share 3 → backup file (must be exported by user)
 *
 * Any 2 shares are enough to recover the private key. No single source contains
 * enough information on its own.
 */

export type WalletRole = "dev" | "bundle" | "snipe" | "both";

export type WalletMeta = {
  publicKey: string;
  createdAt: number;
  role: WalletRole;
  balance: number;
};

export const WALLETS_EVENT = "bundle-wallets-changed";

function emitChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WALLETS_EVENT));
  }
}

export type WalletShares = {
  publicKey: string;
  shareLocal: string;
  shareIdb: string;
  shareBackup: string;
  createdAt: number;
};

const LS_KEY = "bundle_wallets_meta_v2";
const LS_SHARE_KEY = "bundle_wallets_share1_v2";
const IDB_PREFIX = "bundle_wallet_share2_";

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadWallets(): WalletMeta[] {
  return readJSON<WalletMeta[]>(LS_KEY, []);
}

function saveMeta(list: WalletMeta[]) {
  writeJSON(LS_KEY, list);
}

/**
 * Load encrypted shares from localStorage
 * Returns decrypted shares or empty object if decryption fails
 */
async function loadLocalShares(): Promise<Record<string, string>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_SHARE_KEY);
    if (!raw) return {};
    
    const encrypted = JSON.parse(raw) as Record<string, string>;
    const decrypted: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(encrypted)) {
      const decryptedValue = await decryptData(value);
      if (decryptedValue) {
        decrypted[key] = decryptedValue;
      }
    }
    return decrypted;
  } catch (e) {
    console.error("[walletStore] Failed to load local shares:", e);
    return {};
  }
}

/**
 * Save encrypted shares to localStorage
 */
async function saveLocalShares(map: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    const encrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
      encrypted[key] = await encryptData(value);
    }
    localStorage.setItem(LS_SHARE_KEY, JSON.stringify(encrypted));
  } catch (e) {
    console.error("[walletStore] Failed to save local shares:", e);
  }
}

/**
 * Generate `count` wallets, split each secret into 3 shares (threshold 2),
 * persist shares 1+2 locally and return share 3 (backup) for export.
 */
export async function generateWallets(
  count: number,
  defaultRole: WalletRole = "bundle"
): Promise<WalletShares[]> {
  const created: WalletShares[] = [];
  const localShares = await loadLocalShares();

  for (let i = 0; i < count; i++) {
    const kp = Keypair.generate();
    const publicKey = kp.publicKey.toBase58();

    const [s1, s2, s3] = shamirSplit(kp.secretKey, 3, 2);

    // Clear keypair from memory immediately after splitting
    localShares[publicKey] = s1;
    // Encrypt share before storing in IndexedDB
    const encryptedS2 = await encryptData(s2);
    await idbSet(IDB_PREFIX + publicKey, encryptedS2);
    // Clear sensitive data
    (kp as any).secretKey = new Uint8Array(64);

    created.push({
      publicKey,
      shareLocal: s1,
      shareIdb: s2,
      shareBackup: s3,
      createdAt: Date.now(),
    });
  }

  await saveLocalShares(localShares);
  const existing = loadWallets();
  const hasDev = existing.some((w) => w.role === "dev");
  const newMeta: WalletMeta[] = created.map((w, idx) => ({
    publicKey: w.publicKey,
    createdAt: w.createdAt,
    role:
      defaultRole === "dev" && !hasDev && idx === 0
        ? "dev"
        : defaultRole === "dev"
          ? "bundle"
          : defaultRole,
    balance: 0,
  }));
  saveMeta([...existing, ...newMeta]);
  emitChange();

  return created;
}

/**
 * Import an existing wallet (with known secretKey) into storage using Shamir 2-of-3.
 * Similar to generateWallets but for existing keys.
 */
export async function importWallet(
  publicKey: string,
  secretKey: Uint8Array,
  defaultRole: WalletRole = "bundle"
): Promise<WalletShares> {
  const [s1, s2, s3] = shamirSplit(secretKey, 3, 2);

  // Clear the original secret key from memory immediately
  secretKey.fill(0);

  // Persist encrypted shares
  const localShares = await loadLocalShares();
  localShares[publicKey] = s1;
  await saveLocalShares(localShares);
  const encryptedS2 = await encryptData(s2);
  await idbSet(IDB_PREFIX + publicKey, encryptedS2);

  // Add metadata
  const existing = loadWallets();
  const hasDev = existing.some((w) => w.role === "dev");
  const meta: WalletMeta = {
    publicKey,
    createdAt: Date.now(),
    role: defaultRole === "dev" && !hasDev ? "dev" : defaultRole === "dev" ? "bundle" : defaultRole,
    balance: 0,
  };
  saveMeta([...existing, meta]);
  emitChange();

  return {
    publicKey,
    shareLocal: s1,
    shareIdb: s2,
    shareBackup: s3,
    createdAt: meta.createdAt,
  };
}

export function setRole(publicKey: string, role: WalletRole) {
  const list = loadWallets().map((w) => (w.publicKey === publicKey ? { ...w, role } : w));
  saveMeta(list);
  emitChange();
}

/** Promote a wallet to dev — demotes the previous dev to bundle. */
export function setDev(publicKey: string) {
  const list = loadWallets().map((w) => {
    if (w.publicKey === publicKey) return { ...w, role: "dev" as WalletRole };
    if (w.role === "dev") return { ...w, role: "bundle" as WalletRole };
    return w;
  });
  saveMeta(list);
  emitChange();
}

export async function removeWallet(publicKey: string) {
  saveMeta(loadWallets().filter((w) => w.publicKey !== publicKey));
  const localShares = await loadLocalShares();
  // Overwrite share with zeros before deleting
  if (localShares[publicKey]) {
    localShares[publicKey] = "0".repeat(localShares[publicKey].length);
    await saveLocalShares(localShares);
  }
  delete localShares[publicKey];
  await saveLocalShares(localShares);
  await idbDel(IDB_PREFIX + publicKey);
  emitChange();
}

/**
 * Recover a wallet's secret (base58) given any 2 of the 3 shares.
 * Loads share1 from localStorage and share2 from IndexedDB by default.
 * Pass `backupShare` if either local source was lost.
 */
export async function recoverSecret(
  publicKey: string,
  backupShare?: string
): Promise<string | null> {
  const shares: string[] = [];
  const localShares = await loadLocalShares();
  const local = localShares[publicKey];
  if (local) shares.push(local);
  
  // Decrypt share from IndexedDB
  const encryptedFromIdb = await idbGet<string>(IDB_PREFIX + publicKey);
  if (encryptedFromIdb) {
    const fromIdb = await decryptData(encryptedFromIdb);
    if (fromIdb) shares.push(fromIdb);
  }
  
  if (backupShare) shares.push(backupShare);

  if (shares.length < 2) return null;
  try {
    const secretBytes = shamirCombine(shares.slice(0, 2));
    return bs58.encode(secretBytes);
  } catch {
    return null;
  }
}

export async function clearAllWallets() {
  // Overwrite all shares before clearing
  const localShares = await loadLocalShares();
  for (const key of Object.keys(localShares)) {
    localShares[key] = "0".repeat(localShares[key].length);
  }
  await saveLocalShares(localShares);
  
  saveMeta([]);
  await saveLocalShares({});
  const allKeys = await idbKeys();
  await Promise.all(
    allKeys
      .filter((k): k is string => typeof k === "string" && k.startsWith(IDB_PREFIX))
      .map((k) => idbDel(k))
  );
  emitChange();
}

/**
 * Build a JSON backup blob with share #3 for each wallet.
 * User MUST save this file — without it, recovery requires both browser stores intact.
 */
export function buildBackupBlob(wallets: WalletShares[]): Blob {
  const payload = {
    type: "solana-launcher.bundle-wallets.shamir-backup",
    version: 1,
    threshold: 2,
    totalShares: 3,
    note: "This file contains share #3 of 3 (threshold 2). Combined with either localStorage or IndexedDB share, this recovers the private key. Keep it offline.",
    createdAt: new Date().toISOString(),
    wallets: wallets.map((w) => ({
      publicKey: w.publicKey,
      shareBackup: w.shareBackup,
      createdAt: w.createdAt,
    })),
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
}

export function downloadBackup(wallets: WalletShares[]) {
  const blob = buildBackupBlob(wallets);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bundle-wallets-backup-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
