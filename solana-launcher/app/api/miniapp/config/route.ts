import { NextResponse } from "next/server";
import { getSubscriptionSettings } from "@/lib/telegram/subscription-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSubscriptionSettings();
    return NextResponse.json({
      monthlyPriceSol: String(settings.monthly_price_sol),
      monthlyPriceUsdt: String(settings.monthly_price_usdt),
      freeDemoEnabled: settings.free_demo_enabled,
      demoDays: settings.demo_days,
      recipientConfigured: Boolean(settings.solana_recipient_wallet?.trim()),
    });
  } catch (error) {
    console.error("[Mini App] Unable to load subscription settings:", error);
    return NextResponse.json(
      { error: "Subscription settings are temporarily unavailable" },
      { status: 503 }
    );
  }
}
