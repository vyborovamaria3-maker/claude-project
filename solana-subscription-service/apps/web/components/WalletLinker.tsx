"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { KeyRound, Unlink } from "lucide-react";
import { apiFetch } from "../lib/api";

export function WalletLinker() {
  const { publicKey, signMessage } = useWallet();

  async function linkWallet() {
    if (!publicKey || !signMessage) return;
    const address = publicKey.toBase58();
    const { message } = await apiFetch<{ message: string }>("/api/wallet/challenge", {
      method: "POST",
      body: JSON.stringify({ publicKey: address })
    });
    const signatureBytes = await signMessage(new TextEncoder().encode(message));
    const signature = base58Encode(signatureBytes);
    await apiFetch("/api/wallet/link", {
      method: "POST",
      body: JSON.stringify({ publicKey: address, signature })
    });
    window.location.reload();
  }

  async function unlinkWallet() {
    await apiFetch("/api/wallet", { method: "DELETE" });
    window.location.reload();
  }

  return (
    <section className="border border-line bg-white p-5">
      <h2 className="text-lg font-extrabold">Wallet</h2>
      <div className="mt-4">
        <WalletMultiButton />
      </div>
      <div className="mt-4 grid gap-2">
        <button
          type="button"
          onClick={linkWallet}
          disabled={!publicKey || !signMessage}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-mint px-4 text-sm font-black text-ink disabled:cursor-not-allowed disabled:opacity-50"
          title="Link connected wallet"
        >
          <KeyRound className="h-4 w-4" />
          Link wallet
        </button>
        <button
          type="button"
          onClick={unlinkWallet}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line px-4 text-sm font-bold"
          title="Unlink wallet"
        >
          <Unlink className="h-4 w-4" />
          Unlink
        </button>
      </div>
    </section>
  );
}

function base58Encode(bytes: Uint8Array) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map((digit) => alphabet[digit]).join("");
}
