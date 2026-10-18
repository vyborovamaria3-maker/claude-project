import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM envelope. Caller manages the 32-byte key outside source control. */
export function encrypt(key: Uint8Array, plaintext: string): string {
  if (key.byteLength !== 32) throw new RangeError("AES-256-GCM requires a 32-byte key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decrypt(key: Uint8Array, envelope: string): string {
  if (key.byteLength !== 32) throw new RangeError("AES-256-GCM requires a 32-byte key");
  if (typeof envelope !== "string") throw new TypeError("Invalid encrypted envelope");
  const chunks = envelope.split(".");
  if (chunks.length !== 4 || chunks[0] !== "v1") throw new TypeError("Unsupported encrypted envelope");
  const iv = Buffer.from(chunks[1]!, "base64url");
  const tag = Buffer.from(chunks[2]!, "base64url");
  const ciphertext = Buffer.from(chunks[3]!, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new TypeError("Malformed encrypted envelope");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function rotateKey(oldKey: Uint8Array, newKey: Uint8Array, encrypted: string): string {
  return encrypt(newKey, decrypt(oldKey, encrypted));
}
