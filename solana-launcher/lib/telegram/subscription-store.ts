import { getBackendBaseUrl } from "../authProxy";

export type SubscriptionOrder = {
  payload: string;
  telegram_user_id: number;
  username: string | null;
  login: string;
  amount_usd: number;
  status: "pending" | "paid";
  password: string | null;
  invoice_link: string | null;
  provider_charge_id: string | null;
  telegram_payment_charge_id: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  subscription_expires_at: string | null;
  already_paid: boolean;
};

class SubscriptionStoreError extends Error {
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
  const response = await fetch(`${getBackendBaseUrl()}/api/v1/subscriptions${path}`, {
    ...init,
    headers: {
      ...internalHeaders(),
      ...(init?.headers || {}),
    },
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

export async function createSubscriptionOrder(input: {
  payload: string;
  telegramUserId: number;
  username?: string | null;
  login: string;
  amountUsd: number;
  invoiceLink?: string | null;
}): Promise<SubscriptionOrder> {
  const order = await requestBackend<SubscriptionOrder>("/orders", {
    method: "POST",
    body: JSON.stringify({
      payload: input.payload,
      telegram_user_id: input.telegramUserId,
      username: input.username ?? null,
      login: input.login,
      amount_usd: input.amountUsd,
    }),
  });

  if (input.invoiceLink) {
    return updateSubscriptionInvoice(input.payload, input.invoiceLink);
  }
  return order;
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
  providerChargeId?: string | null;
  telegramPaymentChargeId?: string | null;
}): Promise<SubscriptionOrder> {
  return requestBackend<SubscriptionOrder>(
    `/orders/${encodeURIComponent(input.payload)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        password: input.password,
        provider_charge_id: input.providerChargeId ?? null,
        telegram_payment_charge_id: input.telegramPaymentChargeId ?? null,
      }),
    }
  );
}

export async function updateSubscriptionInvoice(
  payload: string,
  invoiceLink: string
): Promise<SubscriptionOrder> {
  return requestBackend<SubscriptionOrder>(
    `/orders/${encodeURIComponent(payload)}/invoice`,
    {
      method: "PATCH",
      body: JSON.stringify({ invoice_link: invoiceLink }),
    }
  );
}
