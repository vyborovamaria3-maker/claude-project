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
const CONSUME_REFRESH_TOKEN_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

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

/**
 * Atomically verifies ownership of a refresh-token JTI and deletes it.
 * A refresh token is therefore single-use even when two refresh requests race.
 */
export async function consumeRefreshToken(jti: string, userId: string) {
  const consumed = await redis.eval(
    CONSUME_REFRESH_TOKEN_SCRIPT,
    1,
    `refresh:${jti}`,
    userId
  );
  return Number(consumed) === 1;
}

export async function isRefreshTokenActive(jti: string, userId: string) {
  const stored = await redis.get(`refresh:${jti}`);
  return stored === userId;
}
