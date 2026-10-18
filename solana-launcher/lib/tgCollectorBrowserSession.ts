import { createHmac, timingSafeEqual } from "node:crypto";

export const TG_COOKIE = "tg_collector_local";
export const TG_COOKIE_PATH = "/api/integrations/tg-collector";
export const TG_SESSION_SECONDS = 8 * 60 * 60;

export function localAutoConnectAllowed(enabled: string | undefined, configuredOrigin: string | undefined, requestOrigin: string, production: boolean): boolean {
  if (production || enabled !== "1" || !configuredOrigin) return false;
  try {
    const url = new URL(configuredOrigin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && ["http:", "https:"].includes(url.protocol) && url.origin === configuredOrigin && configuredOrigin === requestOrigin;
  } catch { return false; }
}

export function createBrowserSession(secret: string, origin: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ origin, expires: now + TG_SESSION_SECONDS * 1000 })).toString("base64url");
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
}

export function validBrowserSession(value: string | undefined, secret: string, origin: string, now = Date.now()): boolean {
  if (!value || value.length > 1024 || secret.length < 24) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const signature = Buffer.from(parts[1], "base64url");
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return false;
  try {
    const body = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return body.origin === origin && Number.isSafeInteger(body.expires) && body.expires > now
      && body.expires <= now + TG_SESSION_SECONDS * 1000;
  } catch { return false; }
}

export function browserRequestOrigin(protocol: string, host: string): string {
  try { return new URL(protocol + "//" + host).origin; } catch { return ""; }
}
