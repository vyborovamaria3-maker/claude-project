import { beforeEach, describe, expect, it, vi } from "vitest";

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

const state = vi.hoisted(() => ({ refresh: new Map<string, string>() }));

vi.mock("../src/lib/redis", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => {
      state.refresh.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => state.refresh.get(key) ?? null),
    del: vi.fn(async (key: string) => state.refresh.delete(key) ? 1 : 0),
    eval: vi.fn(async (_script: string, _keys: number, key: string, expected: string) => {
      if (state.refresh.get(key) !== expected) return 0;
      state.refresh.delete(key);
      return 1;
    })
  }
}));

beforeEach(() => state.refresh.clear());

describe("refresh token rotation", () => {
  it("allows only one concurrent consumer for the same refresh JTI", async () => {
    const { consumeRefreshToken } = await import("../src/security/tokens");
    state.refresh.set("refresh:race-jti", "user-1");

    const results = await Promise.all([
      consumeRefreshToken("race-jti", "user-1"),
      consumeRefreshToken("race-jti", "user-1")
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(state.refresh.has("refresh:race-jti")).toBe(false);
  });

  it("does not consume a token owned by a different user", async () => {
    const { consumeRefreshToken } = await import("../src/security/tokens");
    state.refresh.set("refresh:owned-jti", "user-1");

    await expect(consumeRefreshToken("owned-jti", "user-2")).resolves.toBe(false);
    expect(state.refresh.get("refresh:owned-jti")).toBe("user-1");
  });
});
