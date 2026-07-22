import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "subscription-orders.json");

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
  paid_at: string | null;
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ orders: [] }, null, 2), "utf-8");
  }
}

function readOrders(): SubscriptionOrder[] {
  ensureStore();
  const raw = fs.readFileSync(STORE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { orders?: SubscriptionOrder[] };
  return Array.isArray(parsed.orders) ? parsed.orders : [];
}

function writeOrders(orders: SubscriptionOrder[]) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify({ orders }, null, 2), "utf-8");
}

export function createSubscriptionOrder(input: {
  payload: string;
  telegramUserId: number;
  username?: string | null;
  login: string;
  amountUsd: number;
  invoiceLink?: string | null;
}) {
  const orders = readOrders();
  const existingIndex = orders.findIndex((order) => order.payload === input.payload);
  const next: SubscriptionOrder = {
    payload: input.payload,
    telegram_user_id: input.telegramUserId,
    username: input.username ?? null,
    login: input.login,
    amount_usd: input.amountUsd,
    status: "pending",
    password: null,
    invoice_link: input.invoiceLink ?? null,
    provider_charge_id: null,
    telegram_payment_charge_id: null,
    created_at: new Date().toISOString(),
    paid_at: null,
  };

  if (existingIndex >= 0) {
    orders[existingIndex] = {
      ...orders[existingIndex],
      invoice_link: input.invoiceLink ?? orders[existingIndex].invoice_link,
    };
  } else {
    orders.push(next);
  }

  writeOrders(orders);
}

export function getSubscriptionOrder(payload: string): SubscriptionOrder | null {
  return readOrders().find((order) => order.payload === payload) ?? null;
}

export function markSubscriptionPaid(input: {
  payload: string;
  password: string;
  providerChargeId?: string | null;
  telegramPaymentChargeId?: string | null;
}) {
  const orders = readOrders();
  const index = orders.findIndex((order) => order.payload === input.payload);
  if (index < 0) return;

  orders[index] = {
    ...orders[index],
    status: "paid",
    password: input.password,
    provider_charge_id: input.providerChargeId ?? null,
    telegram_payment_charge_id: input.telegramPaymentChargeId ?? null,
    paid_at: new Date().toISOString(),
  };
  writeOrders(orders);
}

export function updateSubscriptionInvoice(payload: string, invoiceLink: string) {
  const orders = readOrders();
  const index = orders.findIndex((order) => order.payload === payload);
  if (index < 0) return;

  orders[index] = {
    ...orders[index],
    invoice_link: invoiceLink,
  };
  writeOrders(orders);
}
