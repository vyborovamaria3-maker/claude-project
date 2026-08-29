import crypto from "node:crypto";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

export interface TelegramAuthUser {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
}

function hmacHex(secret: crypto.BinaryLike | crypto.KeyObject, data: string) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyTelegramLoginWidget(input: Record<string, unknown>): TelegramAuthUser {
  const hash = String(input.hash ?? "");
  if (!hash) {
    throw new AppError(400, "Telegram hash is missing", "TELEGRAM_HASH_MISSING");
  }

  const dataCheckString = Object.entries(input)
    .filter(([key, value]) => key !== "hash" && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join("\n");

  const secret = crypto.createHash("sha256").update(env.TELEGRAM_BOT_TOKEN).digest();
  const expectedHash = hmacHex(secret, dataCheckString);
  if (!safeEqualHex(hash, expectedHash)) {
    throw new AppError(401, "Invalid Telegram login signature", "INVALID_TELEGRAM_SIGNATURE");
  }

  const authDate = Number(input.auth_date ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 60 * 60 * 24) {
    throw new AppError(401, "Telegram login payload expired", "TELEGRAM_AUTH_EXPIRED");
  }

  return {
    id: String(input.id),
    username: input.username ? String(input.username) : undefined,
    firstName: input.first_name ? String(input.first_name) : undefined,
    lastName: input.last_name ? String(input.last_name) : undefined,
    photoUrl: input.photo_url ? String(input.photo_url) : undefined
  };
}

export function verifyTelegramMiniAppInitData(initData: string): TelegramAuthUser {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    throw new AppError(400, "Telegram Mini App hash is missing", "TELEGRAM_HASH_MISSING");
  }

  params.delete("hash");
  params.delete("signature");
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  const expectedHash = hmacHex(secret, dataCheckString);
  if (!safeEqualHex(hash, expectedHash)) {
    throw new AppError(401, "Invalid Telegram Mini App signature", "INVALID_TELEGRAM_SIGNATURE");
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new AppError(400, "Telegram Mini App user is missing", "TELEGRAM_USER_MISSING");
  }

  const user = JSON.parse(userRaw) as {
    id: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
    photo_url?: string;
  };

  return {
    id: String(user.id),
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    photoUrl: user.photo_url
  };
}
