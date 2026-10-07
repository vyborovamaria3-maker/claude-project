import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from "node:crypto";
function keys(): { active: string; values: Record<string, string> } {
  const active = process.env.REPLY_ACTIVE_KEY_ID ?? "master";
  const values: Record<string, string> = process.env.REPLY_ENCRYPTION_KEYS
    ? JSON.parse(process.env.REPLY_ENCRYPTION_KEYS)
    : { master: process.env.MASTER_KEY ?? "" };
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(active))
    throw new Error("invalid encryption key ID");
  return { active, values };
}
function key(id: string): Buffer {
  const raw = keys().values[id];
  if (!raw) throw new Error("encryption key unavailable");
  const buffer = /^[a-fA-F0-9]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buffer.length !== 32) throw new Error("encryption key must be 32 bytes");
  return buffer;
}
export function seal(value: unknown): string {
  const { active } = keys();
  const iv = randomBytes(12),
    k = key(active);
  try {
    const cipher = createCipheriv("aes-256-gcm", k, iv);
    cipher.setAAD(Buffer.from("reply:v1:" + active));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [
      "aesgcm",
      "v1",
      active,
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"),
    ].join(":");
  } finally {
    k.fill(0);
  }
}
export function unseal<T>(value: string): T {
  const [format, version, id, data, ...extra] = value.split(":");
  if (format !== "aesgcm" || version !== "v1" || !id || !data || extra.length)
    throw new Error("unsupported encrypted envelope");
  const blob = Buffer.from(data, "base64");
  if (blob.length < 29) throw new Error("invalid encrypted envelope");
  const k = key(id);
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", k, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from("reply:v1:" + id));
    decipher.setAuthTag(blob.subarray(12, 28));
    plain = Buffer.concat([
      decipher.update(blob.subarray(28)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as T;
  } finally {
    k.fill(0);
    plain?.fill(0);
  }
}
export function proxyFingerprint(value: string): string {
  // Stable across encryption key rotations; do not log or return the fingerprint.
  const secret = process.env.REPLY_PROXY_HASH_KEY;
  if (!secret || secret.length < 32)
    throw new Error("REPLY_PROXY_HASH_KEY must have at least 32 characters");
  return createHmac("sha256", secret).update(value).digest("hex");
}
