import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireAdminAuth } from "./adminAuth";
import { proxy } from "../proxy";

beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const request = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("https://app.example/admin/x-collector", { method, headers });

describe("administrator authorization", () => {
  it("rejects anonymous production access, including localhost", async () => {
    const backend = vi.fn(); vi.stubGlobal("fetch", backend);
    expect((await requireAdminAuth(request()))?.status).toBe(401);
    expect((await requireAdminAuth(new Request("http://127.0.0.1/admin")))?.status).toBe(401);
    expect(backend).not.toHaveBeenCalled();
  });
  it.each([{}, { is_active: true, is_superuser: false }, { is_active: false, is_superuser: true }, { is_active: true, is_superuser: "true" }])(
    "rejects missing, inactive and subscriber roles: %j", async user => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(user)));
      expect((await requireAdminAuth(request({ authorization: "Bearer valid" })))?.status).toBe(403);
    });
  it("accepts only backend-verified active superusers using the HttpOnly cookie", async () => {
    const backend = vi.fn().mockResolvedValue(Response.json({ is_active: true, is_superuser: true }));
    vi.stubGlobal("fetch", backend);
    expect(await requireAdminAuth(request({ cookie: "potapoff_access_token=valid%2Btoken" }))).toBeNull();
    expect(backend.mock.calls[0][1].headers.Authorization).toBe("Bearer valid+token");
    expect(backend.mock.calls[0][1].cache).toBe("no-store");
  });
  it("fails closed on revoked credentials and backend outages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    expect((await requireAdminAuth(request({ authorization: "Bearer revoked" })))?.status).toBe(401);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect((await requireAdminAuth(request({ authorization: "Bearer valid" })))?.status).toBe(503);
  });
  it("blocks cross-origin and originless mutations before checking credentials", async () => {
    const cases: Record<string, string>[] = [{}, { origin: "https://evil.example" }, { origin: "https://app.example", "sec-fetch-site": "cross-site" }];
    for (const headers of cases) {
      expect((await requireAdminAuth(request(headers, "POST")))?.status).toBe(403);
    }
  });
  it("keeps development bypass limited to loopback", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await requireAdminAuth(new Request("http://127.0.0.1:3310/admin"))).toBeNull();
    expect((await requireAdminAuth(request()))?.status).toBe(401);
  });
});

describe("admin navigation proxy", () => {
  it.each(["/admin", "/admin/x-collector", "/admin/tg-collector", "/admin/tg-invite", "/tg-collector", "/tginvite", "/settings/tginvite", "/launch/tginvite", "/trade/tginvite"])(
    "returns 404 for the former workspace %s when separate admin-site is unconfigured", async pathname => {
      vi.stubEnv("ADMIN_SITE_URL", "");
      expect((await proxy(new NextRequest(`https://app.example${pathname}`))).status).toBe(404);
    });
  it.each(["/admin/twitter-registry"])(
    "does not render %s for an anonymous production visitor", async pathname => {
      const response = await proxy(new NextRequest(`https://app.example${pathname}`));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toContain("no-store");
    });
  it.each([["xcollector", "x-collector"], ["tgcollector", "tg-collector"], ["tginvite", "tg-invite"], ["diagnostics", "diagnostics"], ["apify", "apify"], ["blockchain", "blockchain"]])(
    "redirects the old settings tab %s while preserving other parameters", async (tab, route) => {
      vi.stubEnv("ADMIN_SITE_URL", "https://admin.example");
      const response = await proxy(new NextRequest(`https://app.example/settings?tab=${tab}&lang=ru`));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`https://admin.example/collectors/${route}?lang=ru`);
    });
});
