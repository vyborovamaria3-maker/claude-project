import { NextRequest, NextResponse } from "next/server";
import { getDevTelegramUser, verifyTelegramInitData } from "@/lib/telegram/init-data";
import {
  getSubscriptionOrder,
  markSubscriptionPaid,
} from "@/lib/telegram/subscription-store";
import {
  findVerifiedSolanaPayment,
  getSubscriptionRpcUrl,
  SolanaPaymentCurrency,
} from "@/lib/telegram/solana-pay";

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
    if (!order || order.telegram_user_id !== user.id) {
      return NextResponse.json({ error: "order not found" }, { status: 404 });
    }

    if (order.status === "paid") {
      return NextResponse.json({
        status: "paid",
        payload: order.payload,
        login: order.login,
        password: order.password,
        subscriptionExpiresAt: order.subscription_expires_at,
        paymentSignature: order.payment_signature,
      });
    }
    if (order.status !== "pending") {
      return NextResponse.json({ error: "order is no longer payable" }, { status: 409 });
    }
    if (order.currency !== "SOL" && order.currency !== "USDT") {
      return NextResponse.json({ error: "order does not require a Solana payment" }, { status: 409 });
    }
    if (!order.payment_reference || !order.recipient_wallet) {
      return NextResponse.json({ error: "payment order is incomplete" }, { status: 500 });
    }

    const signature = await findVerifiedSolanaPayment({
      rpcUrl: getSubscriptionRpcUrl(),
      reference: order.payment_reference,
      recipient: order.recipient_wallet,
      currency: order.currency as SolanaPaymentCurrency,
      totalAmount: order.total_amount,
      createdAt: order.created_at,
    });

    if (!signature) {
      return NextResponse.json({ status: "pending" }, { status: 202 });
    }

    const completed = await markSubscriptionPaid({
      payload: order.payload,
      paymentSignature: signature,
    });

    return NextResponse.json({
      status: "paid",
      payload: completed.payload,
      login: completed.login,
      password: completed.password,
      subscriptionExpiresAt: completed.subscription_expires_at,
      paymentSignature: completed.payment_signature,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to verify payment";
    if (message.startsWith("Telegram initData")) {
      return NextResponse.json({ error: "Invalid Telegram session" }, { status: 401 });
    }
    console.error("[Mini App] Solana payment verification failed:", error);
    return NextResponse.json({ error: "Unable to verify Solana payment" }, { status: 503 });
  }
}
