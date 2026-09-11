export function encryptSession(sessionString: string, key: string): string {
  const keyBytes = new TextEncoder().encode(key);
  const dataBytes = new TextEncoder().encode(sessionString);
  const result = new Uint8Array(dataBytes.length);
  for (let i = 0; i < dataBytes.length; i++) {
    result[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return btoa(String.fromCharCode(...result));
}

export function decryptSession(encrypted: string, key: string): string | null {
  try {
    const keyBytes = new TextEncoder().encode(key);
    const decoded = atob(encrypted);
    const dataBytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      dataBytes[i] = decoded.charCodeAt(i) ^ keyBytes[i % keyBytes.length];
    }
    return new TextDecoder().decode(dataBytes);
  } catch {
    return null;
  }
}

export function maskToken(token: string): string {
  if (token.length <= 8) return token.slice(0, 2) + "*".repeat(token.length - 4) + token.slice(-2);
  return token.slice(0, 4) + "*".repeat(Math.max(token.length - 8, 4)) + token.slice(-4);
}
