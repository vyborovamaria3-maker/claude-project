import { NextRequest, NextResponse } from "next/server";
import { generateAccessPassword } from "@/lib/telegram/access";
import { registerPaidAccess } from "@/lib/telegram/register-access";
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
  const order = getSubscriptionOrder(payload);
  if (!order) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  if (order.status === "paid") {
    return NextResponse.json({ ok: true, password: order.password });
  }

  const password = generateAccessPassword();
  await registerPaidAccess({
    telegramId: order.telegram_user_id,
    login: order.login,
    password,
    telegramUsername: order.username,
  });
  markSubscriptionPaid({ payload, password });

  return NextResponse.json({ ok: true, password });
}
