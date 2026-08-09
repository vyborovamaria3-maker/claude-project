import { NextRequest, NextResponse } from "next/server";
import {
  getSubscriptionOrder,
  markSubscriptionPaid,
} from "@/lib/telegram/subscription-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  const body = (await req.json()) as { payload?: string };
  const payload = body.payload || "";
  const order = await getSubscriptionOrder(payload);
  if (!order) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  if (order.status === "paid") {
    return NextResponse.json({ ok: true, password: order.password });
  }

  const completed = await markSubscriptionPaid({
    payload,
    paymentSignature: order.currency === "DEMO" ? null : `dev:${payload}`,
  });

  return NextResponse.json({ ok: true, password: completed.password });
}
