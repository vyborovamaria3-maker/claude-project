import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32, IV_LEN = 12, TAG_LEN = 16;

let keyCache: Buffer | null = null;

function getKey(): Buffer {
  if (keyCache) return keyCache;
  const raw = process.env.MASTER_KEY;
  if (!raw) throw new Error("MASTER_KEY не задан");
  const buf = raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== KEY_LEN) throw new Error(`MASTER_KEY должен быть ${KEY_LEN} байт`);
  keyCache = buf;
  return buf;
}

export function clearKeyCache() { keyCache?.fill(0); keyCache = null; }

export function encryptBuffer(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function decryptBuffer(blob: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv(ALGO, getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]);
}
