"use client";

import { useState, useRef, ChangeEvent } from "react";
import { X, Download, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { importWallet, type WalletRole } from "@/lib/walletStore";

type ImportMode = "file" | "paste";

// data-tag: step3.import.card
export default function ImportWalletsCard({
  onClose,
  defaultRole = "bundle",
}: {
  onClose: () => void;
  defaultRole?: WalletRole;
}) {
  const [mode, setMode] = useState<ImportMode>("paste");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const content = await file.text();
      const imported = await parseAndImport(content, defaultRole);
      setSuccess(`Imported ${imported} wallet${imported === 1 ? "" : "s"} from file`);
    } catch (err: any) {
      // SECURITY: Sanitize error message - never expose raw errors that might contain key data
      const safeError = err?.message?.includes("private key") || err?.message?.includes("secret") 
        ? "Import failed: invalid key format" 
        : (err?.message || "Failed to import from file");
      setError(safeError);
      console.error("[ImportWallets] Import failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePasteImport = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const content = text;
      const imported = await parseAndImport(content, defaultRole);
      setSuccess(`Imported ${imported} wallet${imported === 1 ? "" : "s"}`);
      setText("");
      // SECURITY: Clear textarea content from memory
      (content as any) = null;
    } catch (err: any) {
      // SECURITY: Sanitize error message
      const safeError = err?.message?.includes("private key") || err?.message?.includes("secret") 
        ? "Import failed: invalid key format" 
        : (err?.message || "Failed to import");
      setError(safeError);
      console.error("[ImportWallets] Paste import failed");
    } finally {
      setLoading(false);
    }
  };

  const parseAndImport = async (content: string, role: WalletRole): Promise<number> => {
    const trimmed = content.trim();
    let keys: string[] = [];

    // Try JSON first
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          keys = parsed
            .map((item) => {
              if (typeof item === "string") return item;
              if (item && typeof item.privateKey === "string") return item.privateKey;
              if (item && typeof item.secretKey === "string") return item.secretKey;
              return null;
            })
            .filter(Boolean) as string[];
        } else if (parsed && parsed.wallets && Array.isArray(parsed.wallets)) {
          keys = parsed.wallets
            .map((w: any) => w.privateKey || w.secretKey || null)
            .filter(Boolean) as string[];
        }
      } catch {
        // Not valid JSON, continue to line-by-line parsing
      }
    }

    // If no keys from JSON, parse as one key per line
    if (keys.length === 0) {
      keys = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    // SECURITY: Clear the input content from memory
    (content as any) = null;

    if (keys.length === 0) throw new Error("No valid keys found");

    const validKeys: Uint8Array[] = [];
    for (const keyString of keys) {
      try {
        const bytes = bs58.decode(keyString);
        if (bytes.length === 64) validKeys.push(bytes);
        // Clear the key string from memory
        (keyString as any) = null;
      } catch {
        // Skip invalid keys
      }
    }

    // Clear keys array
    keys.length = 0;

    if (validKeys.length === 0) throw new Error("No valid keys found");

    // Import wallets one by one
    let importedCount = 0;
    for (const secretKey of validKeys) {
      try {
        const kp = Keypair.fromSecretKey(secretKey);
        const publicKey = kp.publicKey.toBase58();
        await importWallet(publicKey, secretKey, role);
        importedCount++;
        // Clear keypair secret key
        (kp as any).secretKey = new Uint8Array(64);
      } catch {
        // Skip failed imports
      }
      // Clear secret key from memory
      secretKey.fill(0);
    }

    // Clear validKeys array
    validKeys.length = 0;

    if (importedCount === 0) {
      throw new Error("Failed to import any wallets");
    }

    return importedCount;
  };

  return (
    <div
      data-tag="step3.import.card"
      className="rounded-xl border border-bg-border bg-bg-card/60 p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Download className="w-5 h-5 text-neon-green" />
          <div className="text-white font-semibold">Import Wallets</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-white/40 hover:text-white transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="text-sm text-white/60">
        Import wallets from file or paste private keys. Supports multiple formats:
      </p>

      <ul className="text-xs text-white/50 space-y-1 list-disc pl-4">
        <li>Exported bundle JSON file (with wallets array)</li>
        <li>One private key per line (Base58)</li>
        <li>JSON array of private keys</li>
        <li>JSON array of objects with privateKey field</li>
      </ul>

      {/* File upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.txt"
        className="hidden"
        onChange={handleFileChange}
      />
      <button
        type="button"
        data-tag="step3.import.load_file"
        onClick={() => fileInputRef.current?.click()}
        disabled={loading}
        className="w-full py-2.5 rounded-lg border border-bg-border bg-bg-soft/40 text-sm text-white/80 hover:border-white/30 hover:text-white disabled:opacity-50 transition"
      >
        <span className="flex items-center justify-center gap-2">
          <Download className="w-4 h-4" />
          Load from File (.json, .txt)
        </span>
      </button>

      {/* Paste area */}
      <textarea
        data-tag="step3.import.textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste private keys or JSON here...&#10;&#10;Supported formats:&#10;&#10;1. Exported bundle:&#10;{&quot;wallets&quot;: [{&quot;type&quot;: &quot;dev&quot;, &quot;privateKey&quot;: &quot;...&quot;}, ...]}&#10;&#10;2. One key per line:&#10;abc123...&#10;xyz789...&#10;&#10;3. JSON array:&#10;[&quot;abc123...&quot;, &quot;xyz789...&quot;]"
        className="w-full h-40 bg-bg-soft/60 border border-bg-border rounded-lg p-3 text-sm font-mono text-white/80 placeholder:text-white/30 focus:outline-none focus:border-neon-green/50 resize-none"
      />

      {/* Warning */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200/80">
          Never share your private keys. Only import keys you control. Balances will be loaded automatically.
        </p>
      </div>

      {/* Error/Success */}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-neon-green/40 bg-neon-green/10 p-3 text-sm text-neon-green flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          {success}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          data-tag="step3.import.cancel"
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-lg border border-bg-border bg-bg-soft/40 text-sm text-white/80 hover:border-white/30 hover:text-white transition"
        >
          Cancel
        </button>
        <button
          type="button"
          data-tag="step3.import.submit"
          onClick={handlePasteImport}
          disabled={loading || !text.trim()}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <Download className="w-4 h-4" />
          <span>{loading ? "Importing..." : "Import Wallets"}</span>
        </button>
      </div>
    </div>
  );
}
