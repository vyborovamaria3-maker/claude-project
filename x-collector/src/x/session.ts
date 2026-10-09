import crypto from "node:crypto";
import type { XCookie } from "./client";

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Расшифровывает сессию X тем же форматом, что и lib/trade/crypto.ts:
 * iv (12 байт) | auth tag (16 байт) | ciphertext, AES-256-GCM.
 * Возвращает строку cookies (расшифрованный storage state).
 */
export function decryptSession(encrypted: Buffer, key: Buffer): string {
  if (key.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  if (encrypted.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = encrypted.subarray(0, IV_LEN);
  const tag = encrypted.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = encrypted.subarray(IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

/**
 * Достаёт cookies из расшифрованной сессии:
 * storageState {cookies:[...]} (x-login) либо голый массив cookies.
 */
export function extractCookies(decrypted: Buffer): XCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw new Error("AUTH_REQUIRED: invalid session format");
  }
  if (Array.isArray(parsed)) return parsed as XCookie[];
  const state = parsed as { cookies?: unknown };
  if (Array.isArray(state?.cookies) && state.cookies.length > 0) return state.cookies as XCookie[];
  throw new Error("AUTH_REQUIRED: session has no cookies");
}
