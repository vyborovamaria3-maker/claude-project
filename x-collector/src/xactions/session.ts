import type { ScrapeAuthState } from "../../lib/trade/twitter-scraper";

const COOKIE_NAME = /^[A-Za-z0-9_\-]+$/;

function isXDomain(value: string): boolean {
  const domain = value.toLowerCase().replace(/^\./, "");
  return domain === "x.com" || domain === "twitter.com" || domain.endsWith(".x.com") || domain.endsWith(".twitter.com");
}

/** Convert the existing encrypted Playwright state into in-memory X HTTP cookies. */
export function cookiesFromStorageState(state: ScrapeAuthState): string {
  if (!state || !Array.isArray(state.cookies)) throw new Error("AUTH_REQUIRED: invalid X storage state");
  const values = new Map<string, string>();
  for (const cookie of state.cookies) {
    if (typeof cookie.name !== "string" || !COOKIE_NAME.test(cookie.name)) continue;
    if (typeof cookie.domain !== "string" || !isXDomain(cookie.domain)) continue;
    if (typeof cookie.value !== "string" || /[\r\n;]/.test(cookie.value)) continue;
    // Prefer first-party x.com cookies if duplicate names are present.
    if (!values.has(cookie.name) || cookie.domain.replace(/^\./, "").toLowerCase() === "x.com") {
      values.set(cookie.name, cookie.value);
    }
  }
  if (!values.get("auth_token") || !values.get("ct0")) {
    throw new Error("AUTH_REQUIRED: X storage state needs auth_token and ct0 cookies");
  }
  return [...values.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}
