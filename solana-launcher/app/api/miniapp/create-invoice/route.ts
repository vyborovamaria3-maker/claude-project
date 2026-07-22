import { NextRequest, NextResponse } from "next/server";
import {
  createOrderPayload,
  normalizeAccessLogin,
  validateAccessLogin,
} from "@/lib/telegram/access";
import { getDevTelegramUser, verifyTelegramInitData } from "@/lib/telegram/init-data";
import {
  createSubscriptionOrder,
  updateSubscriptionInvoice,
} from "@/lib/telegram/subscription-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBSCRIPTION_PRICE_USD = 1000;

function resolveTelegramUser(initData: string) {
  if (initData) {
    return verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN || "");
  }

  if (process.env.NODE_ENV !== "production") {
    return getDevTelegramUser();
  }

  throw new Error("Open this page inside Telegram Mini App");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { initData?: string; login?: string };
    const login = normalizeAccessLogin(body.login || "");
    const loginError = validateAccessLogin(login);
    if (loginError) {
      return NextResponse.json({ error: loginError }, { status: 400 });
    }

    const user = resolveTelegramUser(body.initData || "");
    const payload = createOrderPayload(user.id, login);
    const providerToken = process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN || "";

    createSubscriptionOrder({
      payload,
      telegramUserId: user.id,
      username: user.username || null,
      login,
      amountUsd: SUBSCRIPTION_PRICE_USD,
    });

    if (!providerToken) {
      return NextResponse.json({
        payload,
        devCheckout: true,
        amountUsd: SUBSCRIPTION_PRICE_USD,
      });
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Solana Launcher Pro",
          description: "30-day subscription to Solana Launcher software",
          payload,
          provider_token: providerToken,
          currency: "USD",
          prices: [{ label: "Solana Launcher Pro", amount: SUBSCRIPTION_PRICE_USD * 100 }],
          need_name: false,
          need_email: false,
          is_flexible: false,
        }),
        cache: "no-store",
      }
    );

    const telegramData = (await telegramResponse.json()) as { ok: boolean; result?: string; description?: string };
    if (!telegramData.ok || !telegramData.result) {
      return NextResponse.json(
        { error: telegramData.description || "Telegram invoice creation failed" },
        { status: 502 }
      );
    }

    updateSubscriptionInvoice(payload, telegramData.result);

    return NextResponse.json({
      payload,
      invoiceLink: telegramData.result,
      amountUsd: SUBSCRIPTION_PRICE_USD,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create invoice" },
      { status: 400 }
    );
  }
}
