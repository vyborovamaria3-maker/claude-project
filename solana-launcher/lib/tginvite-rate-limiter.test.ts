import { describe, it, expect } from "vitest";
import { RateLimiter } from "./tginvite-rate-limiter";

describe("RateLimiter", () => {
  it("allows consumption within limit", () => {
    const limiter = new RateLimiter();
    limiter.setLimit("test", { maxHits: 5, windowMs: 60000, burstSize: 2 });
    expect(limiter.tryConsume("test")).toBe(true);
    expect(limiter.tryConsume("test")).toBe(true);
    expect(limiter.tryConsume("test")).toBe(true);
  });

  it("blocks after exceeding limit", () => {
    const limiter = new RateLimiter();
    limiter.setLimit("test", { maxHits: 2, windowMs: 60000, burstSize: 0 });
    limiter.tryConsume("test");
    limiter.tryConsume("test");
    expect(limiter.tryConsume("test")).toBe(false);
  });

  it("reports remaining correctly", () => {
    const limiter = new RateLimiter();
    limiter.setLimit("test", { maxHits: 5, windowMs: 60000, burstSize: 0 });
    expect(limiter.getRemaining("test")).toBe(5);
    limiter.tryConsume("test");
    expect(limiter.getRemaining("test")).toBe(4);
  });

  it("resets state", () => {
    const limiter = new RateLimiter();
    limiter.setLimit("test", { maxHits: 2, windowMs: 60000, burstSize: 0 });
    limiter.tryConsume("test");
    limiter.tryConsume("test");
    expect(limiter.tryConsume("test")).toBe(false);
    limiter.reset("test");
    expect(limiter.tryConsume("test")).toBe(true);
  });

  it("returns Infinity for unknown keys", () => {
    const limiter = new RateLimiter();
    expect(limiter.getRemaining("unknown")).toBe(Infinity);
  });
});
