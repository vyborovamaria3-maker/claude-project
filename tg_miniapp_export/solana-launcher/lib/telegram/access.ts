import crypto from "crypto";

const LOGIN_RE = /^[A-Za-z0-9_]{4,32}$/;
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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

export function generateAccessPassword() {
  let password = "";
  for (let i = 0; i < 32; i++) {
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

export function createOrderPayload() {
  return `sub:${crypto.randomBytes(32).toString("hex")}`;
}
