import { getBackendBaseUrl } from "../authProxy";

export type SubscriptionCurrency = "SOL" | "USDT" | "DEMO";

export type SubscriptionSettings = {
  monthly_price_sol: string;
  monthly_price_usdt: string;
  free_demo_enabled: boolean;
  demo_days: number;
  solana_recipient_wallet: string;
};

export type SubscriptionOrder = {
  payload: string;
  telegram_user_id: number;
  username: string | null;
  login: string;
  currency: SubscriptionCurrency;
  total_amount: number;
  access_days: number;
  status: "pending" | "paid" | "cancelled";
  password: string | null;
  recipient_wallet: string | null;
  payment_reference: string | null;
  payment_url: string | null;
  payment_signature: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  subscription_expires_at: string | null;
  already_paid: boolean;
};

export class SubscriptionStoreError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SubscriptionStoreError";
    this.status = status;
  }
}

function internalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.BACKEND_API_KEY?.trim();
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    return headers;
  }
  if (process.env.NODE_ENV !== "production") {
    headers["X-Dev-Internal"] = "miniapp-subscription";
    return headers;
  }
  throw new Error("BACKEND_API_KEY is required for subscription order access");
}

async function requestBackend<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(internalHeaders())) {
    headers.set(key, value);
  }

  const response = await fetch(`${getBackendBaseUrl()}/api/v1/subscriptions${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "detail" in parsed
        ? String((parsed as { detail?: unknown }).detail || "")
        : "";
    throw new SubscriptionStoreError(
      detail || `Subscription backend request failed: ${response.status}`,
      response.status
    );
  }

  return parsed as T;
}

export async function getSubscriptionSettings(): Promise<SubscriptionSettings> {
  return requestBackend<SubscriptionSettings>("/settings");
}

export async function createSubscriptionOrder(input: {
  payload: string;
  telegramUserId: number;
  username?: string | null;
  login: string;
  currency: SubscriptionCurrency;
  totalAmount: number;
  accessDays: number;
  recipientWallet?: string | null;
  paymentReference?: string | null;
  paymentUrl?: string | null;
}): Promise<SubscriptionOrder> {
  return requestBackend<SubscriptionOrder>("/orders", {
    method: "POST",
    body: JSON.stringify({
      payload: input.payload,
      telegram_user_id: input.telegramUserId,
      username: input.username ?? null,
      login: input.login,
      currency: input.currency,
      total_amount: input.totalAmount,
      access_days: input.accessDays,
      recipient_wallet: input.recipientWallet ?? null,
      payment_reference: input.paymentReference ?? null,
      payment_url: input.paymentUrl ?? null,
    }),
  });
}

export async function getSubscriptionOrder(payload: string): Promise<SubscriptionOrder | null> {
  try {
    return await requestBackend<SubscriptionOrder>(`/orders/${encodeURIComponent(payload)}`);
  } catch (error) {
    if (error instanceof SubscriptionStoreError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function markSubscriptionPaid(input: {
  payload: string;
  password: string;
  paymentSignature?: string | null;
}): Promise<SubscriptionOrder> {
  return requestBackend<SubscriptionOrder>(
    `/orders/${encodeURIComponent(input.payload)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        password: input.password,
        payment_signature: input.paymentSignature ?? null,
      }),
    }
  );
}
