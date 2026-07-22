import { NextRequest, NextResponse } from "next/server";
import { getSubscriptionOrder } from "@/lib/telegram/subscription-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const payload = req.nextUrl.searchParams.get("payload") || "";
  if (!payload) {
    return NextResponse.json({ error: "payload required" }, { status: 400 });
  }

  const order = getSubscriptionOrder(payload);
  if (!order) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  return NextResponse.json({
    payload: order.payload,
    login: order.login,
    status: order.status,
    password: order.status === "paid" ? order.password : null,
    paidAt: order.paid_at,
  });
}
