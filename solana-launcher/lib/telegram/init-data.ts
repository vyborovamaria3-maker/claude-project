import crypto from "crypto";

export type TelegramInitUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
  is_premium?: boolean;
  added_to_attachment_menu?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
  [key: string]: unknown;
};

const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const INIT_DATA_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const TELEGRAM_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function verifyTelegramInitData(initData: string, botToken: string): TelegramInitUser {
  if (!initData || !botToken) {
    throw new Error("Telegram initData is required");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !TELEGRAM_HASH_RE.test(hash)) {
    throw new Error("Telegram initData hash is invalid");
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
    .digest();
  const received = Buffer.from(hash, "hex");

  if (received.length !== calculated.length || !crypto.timingSafeEqual(calculated, received)) {
    throw new Error("Telegram initData signature is invalid");
  }

  const authDate = Number(params.get("auth_date") || "0");
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate <= 0 ||
    authDate < now - INIT_DATA_MAX_AGE_SECONDS ||
    authDate > now + INIT_DATA_MAX_FUTURE_SKEW_SECONDS
  ) {
    throw new Error("Telegram initData is expired or has an invalid timestamp");
  }

  const rawUser = params.get("user");
  if (!rawUser) {
    throw new Error("Telegram initData user is missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    throw new Error("Telegram initData user is invalid");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Telegram initData user is invalid");
  }

  const user = parsed as Partial<TelegramInitUser>;
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) {
    throw new Error("Telegram initData user id is invalid");
  }

  return user as TelegramInitUser;
}

export function getDevTelegramUser(): TelegramInitUser {
  return {
    id: Number(process.env.DEV_TELEGRAM_USER_ID || 8881301382),
    username: process.env.DEV_TELEGRAM_USERNAME || "Soft777bot",
    first_name: "Dev",
    language_code: "en",
    is_premium: false,
    added_to_attachment_menu: false,
    allows_write_to_pm: true,
  };
}
