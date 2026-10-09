import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { q, q1 } from "../trade/pg";
function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32)
    throw new Error("JWT_SECRET must have at least 32 characters");
  return value;
}
export async function issueToken(
  telegramId: string,
  hours = 24,
): Promise<string> {
  if (
    !/^\d{1,20}$/.test(telegramId) ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 720
  )
    throw new Error("invalid telegram ID or token lifetime");
  const user = await q1<{ id: string }>(
    "INSERT INTO reply_users(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO UPDATE SET telegram_id=EXCLUDED.telegram_id RETURNING id",
    [telegramId],
  );
  if (!user) throw new Error("user unavailable");
  const jti = randomUUID();
  const token = jwt.sign({}, secret(), {
    algorithm: "HS256",
    subject: String(user.id),
    jwtid: jti,
    expiresIn: hours * 3600,
    issuer: "x-collector-reply",
    audience: "reply-api",
  });
  await q("INSERT INTO reply_tokens(jti,user_id,expires_at) VALUES($1,$2,$3)", [
    jti,
    user.id,
    new Date(Date.now() + hours * 3600000),
  ]);
  return token;
}
export async function authenticate(
  token: string,
): Promise<{ userId: string; jti: string }> {
  const claims = jwt.verify(token, secret(), {
    algorithms: ["HS256"],
    issuer: "x-collector-reply",
    audience: "reply-api",
  });
  if (typeof claims === "string" || !claims.sub || !claims.jti)
    throw new Error("invalid token");
  const row = await q1(
    "SELECT jti FROM reply_tokens WHERE jti=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()",
    [claims.jti, claims.sub],
  );
  if (!row) throw new Error("revoked or expired token");
  return { userId: claims.sub, jti: claims.jti };
}
