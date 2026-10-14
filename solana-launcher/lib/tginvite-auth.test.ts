import { afterEach, describe, expect, it, vi } from "vitest";
import { requireTGInviteUser } from "./tginvite-auth";

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(method = "POST", extras: Record<string, string> = {}) {
  return new Request("https://test.example/api/tginvite/mtproto", {
    method,
    headers: { ...extras },
  });
}

describe("TGInvite API authorization", () => {
  it("rejects anonymous requests before making a backend call", async () => {
    const backend = vi.fn();
    vi.stubGlobal("fetch", backend);
    const result = await requireTGInviteUser(request());
    expect(result.error?.status).toBe(401);
    expect(backend).not.toHaveBeenCalled();
  });

  it("rejects cross-site state changes", async () => {
    const result = await requireTGInviteUser(request("POST", {
      "authorization": "Bearer ignored",
      "origin": "https://attacker.example",
    }));
    expect(result.error?.status).toBe(403);
  });

  it("rejects invalid credentials from backend", async () => {
    const backend = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", backend);
    const result = await requireTGInviteUser(request("POST", {
      authorization: "Bearer invalid",
      origin: "https://test.example",
    }));
    expect(result.error?.status).toBe(401);
  });

  it("derives the identity from the backend, never a user-supplied id", async () => {
    const backend = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "123e4567-e89b-12d3-a456-426614174000" }) });
    vi.stubGlobal("fetch", backend);
    const result = await requireTGInviteUser(request("POST", {
      authorization: "Bearer valid",
      origin: "https://test.example",
      "x-owner-id": "attacker-user",
    }));
    expect(result.ownerId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(result.authorization).toBe("Bearer valid");
    expect(backend).toHaveBeenCalledTimes(2);
  });

  it("fails closed when backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await requireTGInviteUser(request("GET", { authorization: "Bearer valid" }));
    expect(result.error?.status).toBe(503);
  });
});
