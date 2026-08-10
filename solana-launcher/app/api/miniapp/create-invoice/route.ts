import { NextRequest, NextResponse } from "next/server";
import {
  createOrderPayload,
  normalizeAccessLogin,
  validateAccessLogin,
} from "@/lib/telegram/access";
import { getDevTelegramUser, verifyTelegramInitData } from "@/lib/telegram/init-data";
import {
  createSubscriptionOrder,
  getSubscriptionSettings,
  markSubscriptionPaid,
  SubscriptionCurrency,
} from "@/lib/telegram/subscription-store";
import {
  baseUnitsToDecimal,
  buildSolanaPayUrl,
  decimalToBaseUnits,
  generatePaymentReference,
  validateRecipientWallet,
} from "@/lib/telegram/solana-pay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckoutMethod = Extract<SubscriptionCurrency, "SOL" | "USDT" | "DEMO">;

function resolveTelegramUser(initData: string) {
  if (initData) {
    return verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN || "");
  }

  if (process.env.NODE_ENV !== "production") {
    return getDevTelegramUser();
  }

  throw new Error("Open this page inside Telegram Mini App");
}

function normalizeMethod(value: unknown): CheckoutMethod {
  if (value === "SOL" || value === "USDT" || value === "DEMO") return value;
  throw new Error("Choose SOL, USDT, or demo access");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      initData?: string;
      login?: string;
      method?: CheckoutMethod;
    };
    const login = normalizeAccessLogin(body.login || "");
    const loginError = validateAccessLogin(login);
    if (loginError) {
      return NextResponse.json({ error: loginError }, { status: 400 });
    }

    const method = normalizeMethod(body.method);
    const user = resolveTelegramUser(body.initData || "");
    const settings = await getSubscriptionSettings();

    if (method === "DEMO") {
      if (!settings.free_demo_enabled) {
        return NextResponse.json({ error: "Free demo access is disabled" }, { status: 403 });
      }
      if (!Number.isSafeInteger(settings.demo_days) || settings.demo_days <= 0) {
        throw new Error("Demo duration is not configured correctly");
      }

      const order = await createSubscriptionOrder({
        payload: createOrderPayload(),
        telegramUserId: user.id,
        username: user.username || null,
        telegramProfile: user,
        login,
        currency: "DEMO",
        totalAmount: 0,
        accessDays: settings.demo_days,
      });
      const completed =
        order.status === "paid"
          ? order
          : await markSubscriptionPaid({
              payload: order.payload,
            });

      return NextResponse.json({
        payload: completed.payload,
        mode: "DEMO",
        status: completed.status,
        login: completed.login,
        password: completed.password,
        accessDays: completed.access_days,
        subscriptionExpiresAt: completed.subscription_expires_at,
      });
    }

    if (!settings.paid_subscriptions_enabled) {
      return NextResponse.json(
        { error: "Paid subscriptions are disabled in admin" },
        { status: 403 }
      );
    }

    const recipient = validateRecipientWallet(settings.solana_recipient_wallet);
    const decimals = method === "SOL" ? 9 : 6;
    const configuredPrice =
      method === "SOL" ? settings.monthly_price_sol : settings.monthly_price_usdt;
    const totalAmount = decimalToBaseUnits(String(configuredPrice), decimals);
    if (totalAmount <= 0) {
      return NextResponse.json(
        { error: `${method} subscription price is not configured in admin` },
        { status: 503 }
      );
    }

    const paymentReference = generatePaymentReference();
    const paymentUrl = buildSolanaPayUrl({
      recipient,
      reference: paymentReference,
      currency: method,
      totalAmount,
    });
    const order = await createSubscriptionOrder({
      payload: createOrderPayload(),
      telegramUserId: user.id,
      username: user.username || null,
      telegramProfile: user,
      login,
      currency: method,
      totalAmount,
      accessDays: 30,
      recipientWallet: recipient,
      paymentReference,
      paymentUrl,
    });

    if (order.currency !== "SOL" && order.currency !== "USDT") {
      throw new Error("An existing non-payment activation is still pending");
    }
    if (!order.payment_url || !order.payment_reference) {
      throw new Error("Existing payment checkout is incomplete");
    }

    const returnedDecimals = order.currency === "SOL" ? 9 : 6;
    return NextResponse.json({
      payload: order.payload,
      mode: "PAYMENT",
      currency: order.currency,
      totalAmount: order.total_amount,
      displayAmount: baseUnitsToDecimal(order.total_amount, returnedDecimals),
      paymentUrl: order.payment_url,
      paymentReference: order.payment_reference,
      accessDays: order.access_days,
      reused: order.payment_reference !== paymentReference,
    });
  } catch (error) {
    console.error("[Mini App] Unable to create subscription checkout:", error);
    const message = error instanceof Error ? error.message : "Unable to create checkout";
    const isAuthError =
      message.startsWith("Telegram initData") || message.includes("inside Telegram Mini App");
    const status = isAuthError ? 401 : message.includes("not configured") ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
