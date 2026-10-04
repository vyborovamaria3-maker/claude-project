import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" ||
    (isIP(h) === 6 && h === "::ffff:127.0.0.1");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // Сравниваем буфер с самим собой, чтобы затратить сопоставимое время.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

export type AuthResult = "ok" | "missing" | "invalid";

export function checkBasicAuth(
  header: string | undefined,
  user: string | undefined,
  pass: string | undefined,
): AuthResult {
  if (!user || !pass) return "ok";
  const parsed = parseBasicAuth(header);
  if (!parsed) return "missing";
  const userOk = constantTimeEquals(parsed.user, user);
  const passOk = constantTimeEquals(parsed.pass, pass);
  return userOk && passOk ? "ok" : "invalid";
}

export interface AuthableRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface AuthableResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

/** Возвращает true, если запрос разрешён; иначе отправляет 401 и возвращает false. */
export function enforceBasicAuth(
  req: AuthableRequest,
  res: AuthableResponse,
  user: string | undefined,
  pass: string | undefined,
  realm: string,
): boolean {
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
  const result = checkBasicAuth(header, user, pass);
  if (result === "ok") return true;
  res.setHeader("WWW-Authenticate", `Basic realm="${realm}"`);
  res.statusCode = 401;
  res.end("Unauthorized");
  return false;
}
