import { describe, it, expect } from "vitest";
import { encryptSession, decryptSession, maskToken } from "./tginvite-encryption";

function secret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

describe("authenticated session encryption", () => {
  it("roundtrips through AES-GCM and uses a fresh nonce", async () => {
    const key = secret();
    const a = await encryptSession("abc:123:def:456", key);
    const b = await encryptSession("abc:123:def:456", key);
    expect(a).not.toBe(b);
    expect(await decryptSession(a, key)).toBe("abc:123:def:456");
  });

  it("rejects wrong keys and modified ciphertext", async () => {
    const key = secret();
    const result = await encryptSession("abc:123", key);
    expect(await decryptSession(result, secret())).toBeNull();
    const chars = result.split("");
    chars[chars.length - 2] = chars[chars.length - 2] === "A" ? "B" : "A";
    expect(await decryptSession(chars.join(""), key)).toBeNull();
  });

  it("does not accept legacy XOR payloads", async () => {
    expect(await decryptSession("!!!invalid-base64!!!", secret())).toBeNull();
  });

  it("masks short and long tokens", () => {
    expect(maskToken("12345678901234567890")).toBe("1234************7890");
    expect(maskToken("abc")).toBe("***");
    expect(maskToken("abcdef")).toBe("ab**ef");
  });
});
