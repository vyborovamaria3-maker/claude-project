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

function getSubscriptionPriceStars(): number {
  const value = process.env.TELEGRAM_SUBSCRIPTION_PRICE_STARS?.trim() || "";
  const stars = Number(value);
  if (!Number.isSafeInteger(stars) || stars <= 0) {
    throw new Error("Telegram Stars subscription price is not configured");
  }
  return stars;
}

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
    const totalAmount = getSubscriptionPriceStars();
    const requestedPayload = createOrderPayload();
    const order = await createSubscriptionOrder({
      payload: requestedPayload,
      telegramUserId: user.id,
      username: user.username || null,
      login,
      currency: "XTR",
      totalAmount,
    });
    const payload = order.payload;

    if (order.invoice_link) {
      return NextResponse.json({
        payload,
        invoiceLink: order.invoice_link,
        currency: order.currency,
        totalAmount: order.total_amount,
        reused: true,
      });
    }

    let invoiceLink: string;
    try {
      invoiceLink = await getBot().telegram.callApi("createInvoiceLink", {
        title: "Solana Launcher Pro",
        description: "30-day subscription to Solana Launcher software",
        payload,
        provider_token: "",
        currency: "XTR",
        prices: [{ label: "Solana Launcher Pro - 30 days", amount: totalAmount }],
      });
    } catch (error) {
      console.error("[Mini App] Telegram Stars invoice creation failed:", error);
      return NextResponse.json(
        { error: "Telegram Stars invoice creation failed" },
        { status: 502 }
      );
    }

    await updateSubscriptionInvoice(payload, invoiceLink);

    return NextResponse.json({
      payload,
      invoiceLink,
      currency: "XTR",
      totalAmount,
    });
  } catch (error) {
    console.error("[Mini App] Unable to create invoice:", error);
    const message = error instanceof Error ? error.message : "Unable to create invoice";
    const status = message.includes("not configured") ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
