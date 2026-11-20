#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIRMATION = "I_UNDERSTAND";

export function runComposeDownVolumes({
  env = process.env,
  spawn = spawnSync,
  writeError = (message) => console.error(message),
} = {}) {
  if (env.CONFIRM_DOCKER_VOLUME_DELETION !== CONFIRMATION) {
    writeError(
      "Refusing to remove Docker volumes. Set CONFIRM_DOCKER_VOLUME_DELETION=I_UNDERSTAND explicitly.",
    );
    return 2;
  }

  const result = spawn(
    "docker",
    ["compose", "down", "--volumes"],
    { stdio: "inherit" },
  );
  if (result.error) {
    writeError("Unable to execute Docker Compose volume removal.");
    return 1;
  }
  return result.status ?? 1;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) process.exitCode = runComposeDownVolumes();
