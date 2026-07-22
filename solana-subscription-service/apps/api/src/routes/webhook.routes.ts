import { Router } from "express";
import { z } from "zod";
import { PaymentStatus } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/async-handler";
import { confirmPayment } from "../services/subscription.service";
import { appLink } from "../services/telegram.service";

const router = Router();

router.post(
  "/telegram",
  asyncHandler(async (req, res) => {
    const secret = req.header("x-telegram-bot-api-secret-token");
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "BAD_WEBHOOK_SECRET" });
    }

    const text = req.body?.message?.text as string | undefined;
    const chatId = req.body?.message?.chat?.id as number | string | undefined;
    const telegramId = req.body?.message?.from?.id as number | string | undefined;
    if (!text || !chatId || !telegramId) {
      return res.json({ ok: true });
    }

    const user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
    const response = await telegramCommandReply(String(text), user?.id);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: response,
        reply_markup: { inline_keyboard: [[{ text: "Open app", web_app: { url: env.TELEGRAM_WEBAPP_URL } }]] }
      })
    });
    res.json({ ok: true });
  })
);

const heliusSchema = z.array(
  z.object({
    signature: z.string(),
    instructions: z.unknown().optional(),
    nativeTransfers: z.unknown().optional(),
    tokenTransfers: z.unknown().optional()
  })
);

router.post(
  "/solana",
  asyncHandler(async (req, res) => {
    if (env.HELIUS_WEBHOOK_AUTH_TOKEN) {
      const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
      if (token !== env.HELIUS_WEBHOOK_AUTH_TOKEN) {
        return res.status(401).json({ error: "BAD_WEBHOOK_TOKEN" });
      }
    }

    const events = heliusSchema.parse(req.body);
    for (const event of events) {
      const raw = JSON.stringify(event);
      const pending = await prisma.paymentTransaction.findFirst({
        where: { status: PaymentStatus.PENDING, nonce: { in: extractKnownNonces(raw) } }
      });
      if (pending) {
        await confirmPayment(pending.userId, pending.id, event.signature);
      }
    }

    res.json({ ok: true });
  })
);

async function telegramCommandReply(text: string, userId?: string) {
  if (text.startsWith("/start")) {
    return `Welcome to ${env.APP_NAME}. Open ${appLink()} to sign in and manage your Solana subscription.`;
  }
  if (!userId) {
    return "Open the app first so I can link this Telegram chat to your subscription.";
  }
  if (text.startsWith("/status")) {
    const sub = await prisma.subscription.findFirst({
      where: { userId },
      include: { plan: true },
      orderBy: { updatedAt: "desc" }
    });
    return sub ? `Current plan: ${sub.plan.name}. Status: ${sub.status}. Ends: ${sub.endsAt?.toISOString().slice(0, 10) ?? "n/a"}.` : "No subscription yet.";
  }
  if (text.startsWith("/upgrade")) {
    return `Choose a new plan here: ${appLink("/dashboard")}`;
  }
  if (text.startsWith("/cancel")) {
    await prisma.subscription.updateMany({ where: { userId }, data: { status: "CANCELED" } });
    return "Subscription auto-access has been canceled. Current paid period remains visible in the web app.";
  }
  return "Commands: /status, /upgrade, /cancel.";
}

function extractKnownNonces(raw: string) {
  const matches = raw.match(/solsub-[A-Za-z0-9_-]+/g);
  return matches ?? [];
}

export default router;
