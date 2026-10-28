// Static navigation contract: no live X/Telegram requests and no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
test("settings no longer renders operational collectors", () => {
  const settings = read("app/settings/page.tsx");
  assert.doesNotMatch(settings, /XCollectorTab|TGCollectorTab|xcollector|tgcollector/);
  for (const tab of ["account","quick-actions","activity","diagnostics","apify","blockchain","colors"]) {
    assert.match(settings, new RegExp('id: "' + tab + '"'));
  }
});
test("all three operational workspaces have canonical admin routes", () => {
  assert.match(read("app/admin/x-collector/page.tsx"), /<XCollectorTab \/>/);
  assert.match(read("app/admin/tg-collector/page.tsx"), /<TGCollectorTab \/>/);
  assert.match(read("app/admin/tg-invite/page.tsx"), /<TGInviteWorkspace \/>/);
  const nav = read("components/AdminCollectorTabs.tsx");
  for (const route of ["/admin/x-collector","/admin/tg-collector","/admin/tg-invite"]) {
    assert.ok(nav.includes(route), route);
    assert.ok(read("app/admin/page.tsx").includes(route), route);
  }
});
test("legacy TG Invite paths redirect without rendering a second workspace", () => {
  for (const path of ["app/settings/tginvite/page.tsx","app/tginvite/page.tsx","app/launch/tginvite/page.tsx","app/trade/tginvite/page.tsx"]) {
    const content = read(path);
    assert.match(content, /redirect\("\/admin\/tg-invite"\)/);
    assert.doesNotMatch(content, /<TGInviteWorkspace/);
  }
});
test("main sidebar advertises only the admin hub, not standalone operational links", () => {
  const design = read("lib/siteDesign.ts");
  assert.match(design, /href: "\/admin"/);
  assert.doesNotMatch(design, /href: "\/tginvite"|href: "\/tg-collector"/);
});
