const VERSION = "v1";
function decodeKey(key: string): Uint8Array {
  const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("Expected a base64-encoded 256-bit secret key");
  return bytes;
}
async function importAesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decodeKey(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** Authenticated AES-256-GCM encryption. Keep the secret in server-only configuration. */
export async function encryptSession(sessionString: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, await importAesKey(key), new TextEncoder().encode(sessionString),
  ));
  return `${VERSION}:${btoa(String.fromCharCode(...iv, ...cipher))}`;
}
export async function decryptSession(encrypted: string, key: string): Promise<string | null> {
  try {
    if (!encrypted.startsWith(`${VERSION}:`)) return null;
    const combined = Uint8Array.from(atob(encrypted.slice(VERSION.length + 1)), (c) => c.charCodeAt(0));
    if (combined.length < 29) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: combined.slice(0, 12) },
      await importAesKey(key), combined.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
export function maskToken(token: string): string {
  if (token.length <= 4) return "*".repeat(token.length);
  if (token.length <= 8) return token.slice(0, 2) + "*".repeat(token.length - 4) + token.slice(-2);
  return token.slice(0, 4) + "*".repeat(token.length - 8) + token.slice(-4);
}
