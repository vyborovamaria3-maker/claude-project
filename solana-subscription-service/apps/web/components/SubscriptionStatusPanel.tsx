"use client";

import { Clock, Crown } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { Subscription } from "../lib/types";

export function SubscriptionStatusPanel() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);

  useEffect(() => {
    apiFetch<{ subscription: Subscription | null }>("/api/subscription/status")
      .then((data) => setSubscription(data.subscription))
      .catch(() => undefined);
  }, []);

  return (
    <section className="border border-line bg-white p-5">
      <div className="flex items-center gap-3">
        <Crown className="h-5 w-5 text-saffron" />
        <h2 className="text-xl font-extrabold">Subscription</h2>
      </div>
      {subscription ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatusItem label="Plan" value={subscription.plan.name} />
          <StatusItem label="Status" value={subscription.status} />
          <StatusItem label="Ends" value={subscription.endsAt ? new Date(subscription.endsAt).toLocaleDateString() : "n/a"} />
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2 text-sm text-ink/70">
          <Clock className="h-4 w-4" />
          No active subscription yet.
        </div>
      )}
    </section>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-line bg-panel p-3">
      <p className="text-xs font-bold uppercase tracking-normal text-ink/50">{label}</p>
      <p className="mt-1 text-sm font-black">{value}</p>
    </div>
  );
}
