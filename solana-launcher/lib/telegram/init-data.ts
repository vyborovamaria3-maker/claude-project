import crypto from "crypto";

export type TelegramInitUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export function verifyTelegramInitData(initData: string, botToken: string): TelegramInitUser {
  if (!initData || !botToken) {
    throw new Error("Telegram initData is required");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    throw new Error("Telegram initData hash is missing");
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const calculated = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(calculated, "hex"), Buffer.from(hash, "hex"))) {
    throw new Error("Telegram initData signature is invalid");
  }

  const authDate = Number(params.get("auth_date") || "0");
  if (!authDate || Date.now() / 1000 - authDate > 24 * 60 * 60) {
    throw new Error("Telegram initData is expired");
  }

  const rawUser = params.get("user");
  if (!rawUser) {
    throw new Error("Telegram initData user is missing");
  }

  return JSON.parse(rawUser) as TelegramInitUser;
}

export function getDevTelegramUser(): TelegramInitUser {
  return {
    id: Number(process.env.DEV_TELEGRAM_USER_ID || 8881301382),
    username: process.env.DEV_TELEGRAM_USERNAME || "Soft777bot",
    first_name: "Dev",
  };
}
