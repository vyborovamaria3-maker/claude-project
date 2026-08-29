import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

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

describe("verifyTelegramLoginWidget", () => {
  it("accepts a valid login widget signature", async () => {
    const { verifyTelegramLoginWidget } = await import("../src/security/telegram");
    const payload: Record<string, string> = {
      id: "42",
      first_name: "Ada",
      username: "ada",
      auth_date: String(Math.floor(Date.now() / 1000))
    };

    const checkString = Object.entries(payload)
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("\n");
    const secret = crypto.createHash("sha256").update("123456:ABC").digest();
    payload.hash = crypto.createHmac("sha256", secret).update(checkString).digest("hex");

    expect(verifyTelegramLoginWidget(payload)).toMatchObject({ id: "42", username: "ada" });
  });
});
