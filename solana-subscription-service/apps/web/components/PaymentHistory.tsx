"use client";

import { ReceiptText } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { Payment } from "../lib/types";

export function PaymentHistory() {
  const [payments, setPayments] = useState<Payment[]>([]);

  useEffect(() => {
    apiFetch<{ payments: Payment[] }>("/api/subscription/payments")
      .then((data) => setPayments(data.payments))
      .catch(() => undefined);
  }, []);

  return (
    <section className="border border-line bg-white p-5">
      <div className="flex items-center gap-3">
        <ReceiptText className="h-5 w-5 text-ocean" />
        <h2 className="text-xl font-extrabold">Payment history</h2>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line text-ink/60">
              <th className="py-2">Plan</th>
              <th className="py-2">Amount</th>
              <th className="py-2">Status</th>
              <th className="py-2">Nonce</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <tr key={payment.id} className="border-b border-line">
                <td className="py-3 font-bold">{payment.plan?.name ?? payment.planId}</td>
                <td className="py-3">
                  {payment.expectedAmount} {payment.currency}
                </td>
                <td className="py-3">{payment.status}</td>
                <td className="py-3 font-mono text-xs">{payment.nonce}</td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td className="py-4 text-ink/60" colSpan={4}>
                  No payments yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
