import crypto from "crypto";

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;

export function normalizeAccessLogin(login: string) {
  return login.trim();
}

export function validateAccessLogin(login: string): string | null {
  const normalized = normalizeAccessLogin(login);
  if (!LOGIN_RE.test(normalized)) {
    return "Login must be 4-32 characters: letters, digits, underscore.";
  }
  return null;
}

export function createOrderPayload() {
  return `sub:${crypto.randomBytes(32).toString("hex")}`;
}
