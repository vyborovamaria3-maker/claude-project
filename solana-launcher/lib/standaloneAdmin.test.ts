import { afterEach, expect, it, vi } from "vitest";
import { standaloneAdminUrl } from "./standaloneAdmin";
afterEach(() => vi.unstubAllEnvs());
it.each(["", "javascript:alert(1)", "https://u:p@admin.example", "https://admin.example/path", "http://public.example", "https://admin.example/?next=evil"])("fails closed for invalid admin origin %s", value => {
  vi.stubEnv("ADMIN_SITE_URL", value);
  expect(standaloneAdminUrl("tg-invite")).toBeNull();
});
it("builds only fixed standalone collector routes", () => {
  vi.stubEnv("ADMIN_SITE_URL", "https://admin.example");
  expect(standaloneAdminUrl("tg-invite")).toBe("https://admin.example/collectors/tg-invite");
  expect(standaloneAdminUrl()).toBe("https://admin.example/");
});
