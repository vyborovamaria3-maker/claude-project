import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { env } from "../config/env";
import { redis } from "../lib/redis";

export interface JwtPayload {
  sub: string;
  telegramId: string;
  jti: string;
}

const JWT_ALGORITHM = "HS256" as const;

export function signAccessToken(userId: string, telegramId: string) {
  const payload: JwtPayload = { sub: userId, telegramId, jti: nanoid(18) };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS
  });
}

export async function signRefreshToken(userId: string, telegramId: string) {
  const jti = nanoid(24);
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
