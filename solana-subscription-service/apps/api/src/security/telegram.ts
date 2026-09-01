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

const TELEGRAM_AUTH_MAX_AGE_SECONDS = 60 * 60 * 24;
const TELEGRAM_AUTH_MAX_FUTURE_SKEW_SECONDS = 60 * 5;

function hmacHex(secret: crypto.BinaryLike | crypto.KeyObject, data: string) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function assertFreshAuthDate(rawAuthDate: unknown) {
  const authDate = Number(rawAuthDate ?? 0);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate <= 0 ||
    authDate < now - TELEGRAM_AUTH_MAX_AGE_SECONDS ||
    authDate > now + TELEGRAM_AUTH_MAX_FUTURE_SKEW_SECONDS
  ) {
    throw new AppError(401, "Telegram authentication payload expired", "TELEGRAM_AUTH_EXPIRED");
  }
}

function assertTelegramUserId(rawId: unknown) {
  const id = String(rawId ?? "").trim();
  if (!/^\d+$/.test(id) || id === "0") {
    throw new AppError(400, "Telegram user id is invalid", "TELEGRAM_USER_INVALID");
  }
  return id;
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

  assertFreshAuthDate(input.auth_date);

  return {
    id: assertTelegramUserId(input.id),
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

  assertFreshAuthDate(params.get("auth_date"));

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new AppError(400, "Telegram Mini App user is missing", "TELEGRAM_USER_MISSING");
  }

  let user: {
    id?: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
    photo_url?: string;
  };
  try {
    user = JSON.parse(userRaw) as typeof user;
  } catch {
    throw new AppError(400, "Telegram Mini App user is invalid", "TELEGRAM_USER_INVALID");
  }

  return {
    id: assertTelegramUserId(user.id),
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    photoUrl: user.photo_url
  };
}
