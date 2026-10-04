import { describe, it, expect } from "vitest";
import { parseUsername, formatTime, generateJobId, StealthDelayer } from "./tginvite-stealth";

describe("parseUsername", () => {
  it("parses plain username", () => {
    expect(parseUsername("john_doe")).toBe("john_doe");
  });

  it("parses @username", () => {
    expect(parseUsername("@john_doe")).toBe("john_doe");
  });

  it("parses t.me link", () => {
    expect(parseUsername("https://t.me/john_doe")).toBe("john_doe");
  });

  it("parses invite hash", () => {
    expect(parseUsername("https://t.me/+abc123def")).toBe("+abc123def");
  });

  it("returns null for invalid input", () => {
    expect(parseUsername("ab")).toBeNull();
    expect(parseUsername("http://example.com")).toBeNull();
    expect(parseUsername("")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseUsername("  @john_doe  ")).toBe("john_doe");
  });

  it("rejects special characters", () => {
    expect(parseUsername("john-doe")).toBeNull();
    expect(parseUsername("john.doe")).toBeNull();
  });

  it("accepts min 3 chars", () => {
    expect(parseUsername("abc")).toBe("abc");
    expect(parseUsername("ab")).toBeNull();
  });
});

describe("formatTime", () => {
  it("formats milliseconds", () => {
    expect(formatTime(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatTime(5000)).toBe("5.0s");
  });

  it("formats minutes and seconds", () => {
    expect(formatTime(125000)).toBe("2m 5s");
  });
});

describe("generateJobId", () => {
  it("generates unique ids", () => {
    const id1 = generateJobId();
    const id2 = generateJobId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^job_\d+_[a-z0-9]+$/);
  });
});

describe("StealthDelayer", () => {
  it("delays at least minDelay", async () => {
    const delayer = new StealthDelayer({ minDelay: 50, maxDelay: 100, burstSize: 100 });
    const start = Date.now();
    await delayer.delay();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("resets stats", () => {
    const delayer = new StealthDelayer();
    delayer.reset();
    const stats = delayer.getStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.consecutiveCalls).toBe(0);
  });

  it("tracks total calls", async () => {
    const delayer = new StealthDelayer({ minDelay: 1, maxDelay: 2, burstSize: 100 });
    await delayer.delay();
    await delayer.delay();
    const stats = delayer.getStats();
    expect(stats.totalCalls).toBe(2);
  });
});
