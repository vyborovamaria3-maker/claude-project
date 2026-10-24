import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const workflow=readFileSync(new URL(
  "../.github/workflows/potapoff-release-images.yml",import.meta.url
),"utf8");

function triggerSection(){
  const match=/^on:\n([\s\S]*?)(?=^permissions:)/m.exec(workflow);
  assert.ok(match,"release workflow triggers must precede permissions");
  return match[1];
}

test("release images: only main is an automatic push branch",()=>{
  const triggers=triggerSection();
  assert.match(triggers,/^  push:\n    branches:\n      - main\n/m);
  assert.match(triggers,/^  workflow_dispatch:\s*$/m,
    "manual image publication stays available for a reviewed main SHA");
});

test("release images: suppress documentation-only pushes, not runtime changes",()=>{
  const triggers=triggerSection();
  const push=triggers.split(/^  workflow_dispatch:/m)[0];
  const match=/^    paths-ignore:\n((?:^      - .+\n)+)/m.exec(push);
  assert.ok(match,"documentation-only path exclusion must be scoped to push");
  const patterns=[...match[1].matchAll(/^      - "([^"]+)"$/gm)].map(x=>x[1]);
  assert.deepEqual(patterns,["docs/**","**/*.md","**/*.mdx"],
    "only known documentation paths are excluded, not runtime/workflow/config");
  assert.ok(!/^    paths:\s*$/m.test(push),
    "do not combine conflicting path allowlists with path exclusions");
});

test("release images: main SHA gate, predeploy tests and immutable tags remain",()=>{
  assert.match(workflow,/name: Require main branch/);
  assert.match(workflow,/uses: \.\/\.github\/workflows\/potapoff-predeploy-gate\.yml/);
  assert.match(workflow,/RELEASE_IMAGES_PUBLISHED sha=\$\{GITHUB_SHA\}/);
  assert.match(workflow,/Build and publish immutable SHA images/);
  for(const image of ["backend","frontend","telegram-bot"])
    assert.match(workflow,new RegExp("IMAGE_NAMESPACE }}/"+image+":\\$\\{\\{ github\\.sha \\}\\}"));
});
