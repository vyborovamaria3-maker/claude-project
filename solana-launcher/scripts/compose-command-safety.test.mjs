import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const destructive = await readFile(resolve(root, "scripts/compose-down-volumes.mjs"), "utf8");

test("ordinary Compose down never removes named volumes", () => {
  assert.equal(pkg.scripts["compose:down"], "docker compose down");
  assert.doesNotMatch(pkg.scripts["compose:down"], /(^|\s)(-v|--volumes)(\s|$)/);
});

test("volume deletion is separate and requires explicit confirmation", () => {
  assert.equal(pkg.scripts["compose:down:volumes"], "node scripts/compose-down-volumes.mjs");
  assert.match(destructive, /CONFIRM_DOCKER_VOLUME_DELETION/);
  assert.match(destructive, /I_UNDERSTAND/);
  assert.match(destructive, /\["compose", "down", "--volumes"\]/);
});
