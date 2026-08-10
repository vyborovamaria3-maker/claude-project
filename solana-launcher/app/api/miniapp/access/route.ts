import { NextRequest, NextResponse } from "next/server";
import { getDevTelegramUser, verifyTelegramInitData } from "@/lib/telegram/init-data";
import { getLatestSubscriptionAccess } from "@/lib/telegram/subscription-store";

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
    const body = (await req.json()) as { initData?: string };
    const user = resolveTelegramUser(body.initData || "");
    const access = await getLatestSubscriptionAccess(user.id);

    if (!access) {
      return NextResponse.json({ status: "none" }, { status: 404 });
    }
    if (!access.password || access.password.length !== 32) {
      throw new Error("Active access credentials are unavailable");
    }

    return NextResponse.json({
      status: "paid",
      payload: access.payload,
      login: access.login,
      password: access.password,
      subscriptionExpiresAt: access.subscription_expires_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to recover access";
    if (message.startsWith("Telegram initData")) {
      return NextResponse.json({ error: "Invalid Telegram session" }, { status: 401 });
    }
    console.error("[Mini App] Unable to recover active access:", error);
    return NextResponse.json({ error: "Unable to recover active access" }, { status: 503 });
  }
}
