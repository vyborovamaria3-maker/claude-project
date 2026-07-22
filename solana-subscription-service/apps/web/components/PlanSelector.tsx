"use client";

import { Buffer } from "buffer";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Check, ExternalLink, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { Payment, Plan } from "../lib/types";

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TREASURY_WALLET = process.env.NEXT_PUBLIC_TREASURY_WALLET ?? "";

export function PlanSelector() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [period, setPeriod] = useState<"MONTHLY" | "YEARLY">("MONTHLY");
  const [currency, setCurrency] = useState<"SOL" | "USDC">("SOL");
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [pendingPayment, setPendingPayment] = useState<Payment | null>(null);
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  useEffect(() => {
    apiFetch<{ plans: Plan[] }>("/api/plans").then((data) => setPlans(data.plans)).catch(() => undefined);
  }, []);

  async function initiate(planId: string) {
    setBusyPlan(planId);
    try {
      const data = await apiFetch<{ payment: Payment }>("/api/subscription/initiate", {
        method: "POST",
        body: JSON.stringify({ planId, period, currency })
      });
      setPendingPayment(data.payment);
      if (currency === "SOL" && publicKey && TREASURY_WALLET) {
        await paySol(data.payment);
      }
    } finally {
      setBusyPlan(null);
    }
  }

  async function paySol(payment: Payment) {
    if (!publicKey) throw new Error("Connect a wallet first");
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(TREASURY_WALLET),
        lamports: Math.round(Number(payment.expectedAmount) * LAMPORTS_PER_SOL)
      }),
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey(MEMO_PROGRAM_ID),
        data: Buffer.from(payment.nonce)
      })
    );
    const signature = await sendTransaction(tx, connection);
    await connection.confirmTransaction(signature, "confirmed");
    await apiFetch("/api/subscription/confirm", {
      method: "POST",
      body: JSON.stringify({ paymentId: payment.id, signature })
    });
    window.location.reload();
  }

  return (
    <section className="border border-line bg-white p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-extrabold">Plans</h2>
          <p className="text-sm text-ink/70">Pay in SOL directly from your wallet or open a Solana Pay USDC link.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {(["MONTHLY", "YEARLY"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setPeriod(value)}
              className={`h-9 rounded-md border px-3 font-bold ${period === value ? "border-ink bg-ink text-white" : "border-line"}`}
            >
              {value === "MONTHLY" ? "Month" : "Year"}
            </button>
          ))}
          {(["SOL", "USDC"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setCurrency(value)}
              className={`h-9 rounded-md border px-3 font-bold ${currency === value ? "border-mint bg-mint text-ink" : "border-line"}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const price = period === "YEARLY" ? plan.yearlySol : plan.monthlySol;
          return (
            <article key={plan.id} className="border border-line p-4">
              <h3 className="text-lg font-black">{plan.name}</h3>
              <p className="mt-2 min-h-12 text-sm leading-6 text-ink/70">{plan.description}</p>
              <p className="mt-4 text-3xl font-black">{price} SOL</p>
              <ul className="mt-4 space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-mint" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => initiate(plan.id)}
                disabled={busyPlan === plan.id}
                className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-black text-white disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
                {busyPlan === plan.id ? "Creating..." : "Subscribe"}
              </button>
            </article>
          );
        })}
      </div>

      {pendingPayment && currency === "USDC" && (
        <div className="mt-5 border border-saffron bg-saffron/10 p-4">
          <p className="text-sm font-bold">Payment intent created: {pendingPayment.expectedAmount} USDC</p>
          <a
            href={pendingPayment.paymentUrl}
            className="mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-saffron px-4 text-sm font-black text-ink"
          >
            <ExternalLink className="h-4 w-4" />
            Open Solana Pay
          </a>
        </div>
      )}
    </section>
  );
}
