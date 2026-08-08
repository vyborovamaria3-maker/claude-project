import { NextRequest, NextResponse } from "next/server";
import { getDevTelegramUser, verifyTelegramInitData } from "@/lib/telegram/init-data";
import { getSubscriptionOrder } from "@/lib/telegram/subscription-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveTelegramUser(initData: string) {
  if (initData) {
    return verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN || "");
  }
  if (process.env.NODE_ENV !== "production") {
    return getDevTelegramUser();
  }
  throw new Error("Telegram initData is required");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { payload?: string; initData?: string };
    const payload = body.payload?.trim() || "";
    if (!payload) {
      return NextResponse.json({ error: "payload required" }, { status: 400 });
    }

    const user = resolveTelegramUser(body.initData || "");
    const order = await getSubscriptionOrder(payload);
    if (!order) {
      return NextResponse.json({ error: "order not found" }, { status: 404 });
    }
    if (order.telegram_user_id !== user.id) {
      return NextResponse.json({ error: "order not found" }, { status: 404 });
    }

    return NextResponse.json({
      payload: order.payload,
      login: order.login,
      status: order.status,
      password: order.status === "paid" ? order.password : null,
      paidAt: order.paid_at,
      subscriptionExpiresAt: order.subscription_expires_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read order";
    if (message.startsWith("Telegram initData")) {
      return NextResponse.json({ error: "Invalid Telegram session" }, { status: 401 });
    }
    console.error("[Mini App] Unable to read order:", error);
    return NextResponse.json({ error: "Unable to read order" }, { status: 503 });
  }
}
