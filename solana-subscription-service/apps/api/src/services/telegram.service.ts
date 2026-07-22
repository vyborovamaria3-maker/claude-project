import { NotificationStatus, NotificationType, type User } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";

export async function sendTelegramMessage(user: Pick<User, "id" | "telegramId">, message: string, type: NotificationType) {
  const chatId = user.telegramId;
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "Open subscription", web_app: { url: env.TELEGRAM_WEBAPP_URL } }]]
        }
      })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    await prisma.notificationLog.create({
      data: { userId: user.id, telegramChatId: chatId, message, type, status: NotificationStatus.SENT }
    });
  } catch (error) {
    await prisma.notificationLog.create({
      data: {
        userId: user.id,
        telegramChatId: chatId,
        message,
        type,
        status: NotificationStatus.FAILED,
        error: error instanceof Error ? error.message : "Unknown Telegram error"
      }
    });
  }
}

export function appLink(path = "/dashboard") {
  return `${env.WEB_PUBLIC_URL}${path}`;
}
