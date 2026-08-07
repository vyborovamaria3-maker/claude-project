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
import { getBot } from "@/telegram-bot/index";

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
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json(
          { error: "Telegram payment provider is not configured" },
          { status: 503 }
        );
      }

      return NextResponse.json({
        payload,
        devCheckout: true,
        amountUsd: SUBSCRIPTION_PRICE_USD,
      });
    }

    let invoiceLink: string;
    try {
      invoiceLink = await getBot().telegram.callApi("createInvoiceLink", {
        title: "Solana Launcher Pro",
        description: "30-day subscription to Solana Launcher software",
        payload,
        provider_token: providerToken,
        currency: "USD",
        prices: [{ label: "Solana Launcher Pro", amount: SUBSCRIPTION_PRICE_USD * 100 }],
        need_name: false,
        need_email: false,
        is_flexible: false,
      });
    } catch (error) {
      console.error("[Mini App] Telegram invoice creation failed:", error);
      return NextResponse.json(
        { error: "Telegram invoice creation failed" },
        { status: 502 }
      );
    }

    updateSubscriptionInvoice(payload, invoiceLink);

    return NextResponse.json({
      payload,
      invoiceLink,
      amountUsd: SUBSCRIPTION_PRICE_USD,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create invoice" },
      { status: 400 }
    );
  }
}
