#!/usr/bin/env node
import { spawnSync } from "node:child_process";

if (process.env.CONFIRM_DOCKER_VOLUME_DELETION !== "I_UNDERSTAND") {
  console.error("Refusing to remove Docker volumes. Set CONFIRM_DOCKER_VOLUME_DELETION=I_UNDERSTAND explicitly.");
  process.exitCode = 2;
} else {
  const result = spawnSync("docker", ["compose", "down", "--volumes"], { stdio: "inherit" });
  if (result.error) {
    console.error("Unable to execute Docker Compose volume removal.");
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
