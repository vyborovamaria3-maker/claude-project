export interface User {
  id: string;
  telegramId: string;
  telegramUsername?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  wallets: Wallet[];
}

export interface Wallet {
  id: string;
  publicKey: string;
  isPrimary: boolean;
}

export interface Plan {
  id: "BASIC" | "ADVANCED" | "PREMIUM";
  name: string;
  description: string;
  monthlySol: string;
  yearlySol: string;
  features: string[];
}

export interface Payment {
  id: string;
  planId: string;
  period: "MONTHLY" | "YEARLY";
  currency: "SOL" | "USDC";
  expectedAmount: string;
  nonce: string;
  paymentUrl: string;
  status: string;
  signature?: string | null;
  expiresAt: string;
  createdAt: string;
  plan?: Plan;
}

export interface Subscription {
  id: string;
  status: string;
  period: string;
  startsAt?: string | null;
  endsAt?: string | null;
  plan: Plan;
}
