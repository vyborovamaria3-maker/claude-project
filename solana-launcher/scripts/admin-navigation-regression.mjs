// Static navigation contract: no live X/Telegram requests and no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
test("settings no longer renders operational collectors", () => {
  const settings = read("app/settings/page.tsx");
  assert.doesNotMatch(settings, /XCollectorTab|TGCollectorTab|TGInviteWorkspace|DiagnosticsTab|ApifyTab|BlockchainTab|xcollector|tgcollector|tginvite/);
  assert.doesNotMatch(settings, /id: "(?:diagnostics|apify|blockchain)"/);
  for (const tab of ["account","quick-actions","activity","colors"]) {
    assert.match(settings, new RegExp('id: "' + tab + '"'));
  }
});
test("the product app never renders operational collector workspaces", () => {
  for (const path of ["app/admin/page.tsx", "app/admin/x-collector/page.tsx", "app/admin/tg-collector/page.tsx", "app/admin/tg-invite/page.tsx", "app/tg-collector/page.tsx"]) {
    assert.match(read(path), /redirectToStandaloneAdmin/);
    assert.doesNotMatch(read(path), /XCollectorTab|TGCollectorTab|TGInviteWorkspace|AdminCollectorTabs/);
  }
});
test("legacy TG Invite paths redirect without rendering a second workspace", () => {
  for (const path of ["app/settings/tginvite/page.tsx","app/tginvite/page.tsx","app/launch/tginvite/page.tsx","app/trade/tginvite/page.tsx"]) {
    const content = read(path);
    assert.match(content, /redirectToStandaloneAdmin\("tg-invite"\)/);
    assert.doesNotMatch(content, /<TGInviteWorkspace/);
  }
});
test("main sidebar has no operational collectors or admin collector hub", () => {
  const design = read("lib/siteDesign.ts");
  assert.doesNotMatch(design, /href: "\/(?:admin|tginvite|tg-collector)(?:\/|\")/);
  assert.doesNotMatch(read("components/AdminCollectorTabs.tsx"), /href: "\/admin\/(?:x-collector|tg-collector|tg-invite)"/);
});
