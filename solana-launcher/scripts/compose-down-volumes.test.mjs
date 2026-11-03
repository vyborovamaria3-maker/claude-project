import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runComposeDownVolumes } from "./compose-down-volumes.mjs";

test("ordinary compose:down keeps named volumes", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.scripts["compose:down"], "docker compose down");
  assert.equal(
    manifest.scripts["compose:down:volumes"],
    "node scripts/compose-down-volumes.mjs",
  );
});

test("volume deletion requires the exact explicit confirmation", () => {
  for (const confirmation of [undefined, "true", "I_UNDERSTAND "]) {
    const errors: string[] = [];
    let calls = 0;
    const env =
      confirmation === undefined
        ? {}
        : { CONFIRM_DOCKER_VOLUME_DELETION: confirmation };
    const status = runComposeDownVolumes({
      env,
      spawn: () => {
        calls++;
        return { status: 0 };
      },
      writeError: (message) => errors.push(message),
    });
    assert.equal(status, 2);
    assert.equal(calls, 0);
    assert.match(errors[0], /Refusing to remove Docker volumes/);
  }
});

test("exact opt-in runs only docker compose down --volumes", () => {
  const calls: unknown[][] = [];
  const status = runComposeDownVolumes({
    env: { CONFIRM_DOCKER_VOLUME_DELETION: "I_UNDERSTAND" },
    spawn: (...args: unknown[]) => {
      calls.push(args);
      return { status: 0 };
    },
    writeError: (message) => assert.fail(message),
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ["docker", ["compose", "down", "--volumes"], { stdio: "inherit" }],
  ]);
});

test("spawn failures return a nonzero status without printing raw error details", () => {
  const errors: string[] = [];
  const status = runComposeDownVolumes({
    env: { CONFIRM_DOCKER_VOLUME_DELETION: "I_UNDERSTAND" },
    spawn: () => ({ status: null, error: new Error("private process details") }),
    writeError: (message) => errors.push(message),
  });
  assert.equal(status, 1);
  assert.deepEqual(errors, ["Unable to execute Docker Compose volume removal."]);
});

test("Docker exit status is propagated", () => {
  const status = runComposeDownVolumes({
    env: { CONFIRM_DOCKER_VOLUME_DELETION: "I_UNDERSTAND" },
    spawn: () => ({ status: 17 }),
    writeError: (message) => assert.fail(message),
  });
  assert.equal(status, 17);
});
