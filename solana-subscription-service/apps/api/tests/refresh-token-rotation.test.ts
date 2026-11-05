import { afterEach, describe, expect, it, vi } from "vitest";

const { evalMock } = vi.hoisted(() => ({ evalMock: vi.fn() }));
vi.mock("../src/lib/redis", () => ({ redis: { eval: evalMock } }));

vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
vi.stubEnv("API_PUBLIC_URL", "http://localhost:4000");
vi.stubEnv("WEB_PUBLIC_URL", "http://localhost:3000");
vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
vi.stubEnv("REDIS_URL", "redis://localhost:6379");
vi.stubEnv("JWT_ACCESS_SECRET", "a".repeat(64));
vi.stubEnv("JWT_REFRESH_SECRET", "b".repeat(64));
vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:ABC");
vi.stubEnv("TELEGRAM_BOT_USERNAME", "SolSubBot");
vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "secret-secret");
vi.stubEnv("TELEGRAM_WEBAPP_URL", "http://localhost:3000");
vi.stubEnv("RPC_ENDPOINT", "https://api.devnet.solana.com");
vi.stubEnv("TREASURY_WALLET", "11111111111111111111111111111111");
vi.stubEnv("TREASURY_USDC_TOKEN_ACCOUNT", "11111111111111111111111111111111");
vi.stubEnv("USDC_MINT", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
vi.stubEnv("PAYMENT_CONFIRMATION_COMMITMENT", "finalized");

afterEach(() => vi.restoreAllMocks());

describe("rotateRefreshToken", () => {
  it("uses one Redis Lua operation to consume and replace a refresh token", async () => {
    evalMock.mockResolvedValueOnce(1);
    const { rotateRefreshToken, verifyRefreshToken } = await import("../src/security/tokens");
    const token = await rotateRefreshToken("old-jti", "user-1", "123456");
    expect(token).toBeTruthy();
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keyCount, oldKey, newKey, owner, ttl] = evalMock.mock.calls[0];
    expect(keyCount).toBe(2);
    expect(oldKey).toBe("refresh:old-jti");
    expect(newKey).toMatch(/^refresh:/);
    expect(newKey).not.toBe(oldKey);
    expect(owner).toBe("user-1");
    expect(ttl).toBe("2592000");
    expect(script).toContain("redis.call('GET', KEYS[1])");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect(script).toContain("redis.call('SET', KEYS[2]");
    expect(verifyRefreshToken(token!).sub).toBe("user-1");
  });

  it("rejects a refresh token already consumed by a concurrent request", async () => {
    evalMock.mockResolvedValueOnce(0);
    const { rotateRefreshToken } = await import("../src/security/tokens");
    await expect(rotateRefreshToken("old-jti", "user-1", "123456")).resolves.toBeNull();
    expect(evalMock).toHaveBeenCalledTimes(1);
  });
});
