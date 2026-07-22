export type BillingPeriod = "MONTHLY" | "YEARLY";
export type PaymentCurrency = "SOL" | "USDC";

export type SubscriptionTier = "BASIC" | "ADVANCED" | "PREMIUM";

export interface PlanDefinition {
  code: SubscriptionTier;
  name: string;
  description: string;
  monthlySol: number;
  yearlySol: number;
  features: string[];
}

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    code: "BASIC",
    name: "Basic",
    description: "Core wallet access and renewal reminders.",
    monthlySol: 0.1,
    yearlySol: 1,
    features: ["Subscription status", "Telegram renewal notices", "Wallet binding"]
  },
  {
    code: "ADVANCED",
    name: "Advanced",
    description: "More analytics and faster support workflows.",
    monthlySol: 0.5,
    yearlySol: 5,
    features: ["Everything in Basic", "Payment history", "Priority Telegram commands"]
  },
  {
    code: "PREMIUM",
    name: "Premium",
    description: "Premium wallet analytics and gated content.",
    monthlySol: 2,
    yearlySol: 20,
    features: ["Everything in Advanced", "Premium dashboard", "Demo transaction analytics"]
  }
];

export const SOLANA_MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export function amountForPeriod(plan: PlanDefinition, period: BillingPeriod): number {
  return period === "YEARLY" ? plan.yearlySol : plan.monthlySol;
}

export function addBillingPeriod(date: Date, period: BillingPeriod): Date {
  const next = new Date(date);
  if (period === "YEARLY") {
    next.setFullYear(next.getFullYear() + 1);
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}
