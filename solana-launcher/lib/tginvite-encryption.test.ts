import { describe, it, expect } from "vitest";
import { encryptSession, decryptSession, maskToken } from "./tginvite-encryption";

describe("encryptSession / decryptSession", () => {
  it("roundtrips correctly", () => {
    const session = "abc:123:def:456";
    const key = "my-secret-key";
    const encrypted = encryptSession(session, key);
    expect(encrypted).not.toBe(session);
    const decrypted = decryptSession(encrypted, key);
    expect(decrypted).toBe(session);
  });

  it("returns null for wrong key", () => {
    const session = "abc:123";
    const encrypted = encryptSession(session, "key1");
    const result = decryptSession(encrypted, "key2");
    expect(result).not.toBe(session);
  });

  it("returns null for invalid input", () => {
    expect(decryptSession("!!!invalid-base64!!!", "key")).toBeNull();
  });
});

describe("maskToken", () => {
  it("masks long tokens", () => {
    const token = "12345678901234567890";
    const masked = maskToken(token);
    expect(masked).toBe("1234************7890");
    expect(masked.length).toBe(token.length);
  });

  it("masks short tokens", () => {
    const token = "abcdef";
    const masked = maskToken(token);
    expect(masked.startsWith("ab")).toBe(true);
    expect(masked.endsWith("ef")).toBe(true);
  });
});
