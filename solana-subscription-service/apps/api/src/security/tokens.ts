import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { redis } from "../lib/redis";

export interface JwtPayload {
  sub: string;
  telegramId: string;
  jti: string;
}

const JWT_ALGORITHM = "HS256" as const;

function randomId(length: number): string {
  const bytes = Math.ceil((length * 3) / 4);
  return randomBytes(bytes).toString("base64url").slice(0, length);
}

export function signAccessToken(userId: string, telegramId: string) {
  const payload: JwtPayload = { sub: userId, telegramId, jti: randomId(18) };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS
  });
}

export async function signRefreshToken(userId: string, telegramId: string) {
  const jti = randomId(24);
  const payload: JwtPayload = { sub: userId, telegramId, jti };
  const token = jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: env.REFRESH_TOKEN_TTL_SECONDS
  });
  await redis.set(`refresh:${jti}`, userId, "EX", env.REFRESH_TOKEN_TTL_SECONDS);
  return token;
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [JWT_ALGORITHM] }) as JwtPayload;
}

export function verifyRefreshToken(token: string) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: [JWT_ALGORITHM] }) as JwtPayload;
}

export async function revokeRefreshToken(jti: string) {
  await redis.del(`refresh:${jti}`);
}

export async function isRefreshTokenActive(jti: string, userId: string) {
  const stored = await redis.get(`refresh:${jti}`);
  return stored === userId;
}

/**
 * Atomically consume the current refresh token and install its successor.
 * Concurrent refresh requests cannot both pass a separate GET/DEL sequence.
 */
export async function rotateRefreshToken(jti: string, userId: string, telegramId: string): Promise<string | null> {
  const nextJti = randomId(24);
  const payload: JwtPayload = { sub: userId, telegramId, jti: nextJti };
  const token = jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: env.REFRESH_TOKEN_TTL_SECONDS
  });
  const script = [
    "local current = redis.call('GET', KEYS[1])",
    "if current ~= ARGV[1] then return 0 end",
    "redis.call('DEL', KEYS[1])",
    "redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])",
    "return 1"
  ].join("\\n");
  const rotated = await redis.eval(
    script, 2, `refresh:${jti}`, `refresh:${nextJti}`,
    userId, String(env.REFRESH_TOKEN_TTL_SECONDS)
  );
  return Number(rotated) === 1 ? token : null;
}
