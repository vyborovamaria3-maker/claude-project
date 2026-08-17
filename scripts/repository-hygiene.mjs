import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

const MAX_TRACKED_BYTES = 10 * 1024 * 1024;
const LEGACY_ALLOWLIST = new Set([
  "POTAPoff-landing-minimal-v3.zip",
]);

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"));

const violations = [];

function isEnvExample(base) {
  return (
    base.includes(".example") ||
    base.includes(".template") ||
    base.includes(".sample")
  );
}

for (const file of tracked) {
  if (LEGACY_ALLOWLIST.has(file)) continue;

  const base = path.posix.basename(file);
  const lower = file.toLowerCase();
  const baseLower = base.toLowerCase();

  if (
    (baseLower === ".env" || baseLower.startsWith(".env.")) &&
    !isEnvExample(baseLower)
  ) {
    violations.push(`${file} (environment file)`);
  }

  if (
    ["storage-state.json", "auth-state.json", "session-state.json"].includes(
      baseLower,
    )
  ) {
    violations.push(`${file} (auth/session state)`);
  }

  if (baseLower.startsWith("tmp-")) {
    violations.push(`${file} (temporary file)`);
  }

  if (baseLower.endsWith(".vsix")) {
    violations.push(`${file} (VSIX package)`);
  }

  if (/\.(db|sqlite|sqlite3)$/i.test(base)) {
    violations.push(`${file} (local database)`);
  }

  if (baseLower.endsWith(".zip")) {
    violations.push(`${file} (archive)`);
  }

  if (lower.split("/").includes("node_modules")) {
    violations.push(`${file} (node_modules)`);
  }

  try {
    const stat = lstatSync(file);
    if (stat.isFile() && stat.size > MAX_TRACKED_BYTES) {
      violations.push(
        `${file} (${Math.ceil(stat.size / 1024 / 1024)} MiB tracked file)`,
      );
    }
  } catch {
    violations.push(`${file} (unable to stat tracked path)`);
  }
}

const unique = [...new Set(violations)].sort();

if (unique.length) {
  console.error("Repository hygiene check failed:");
  for (const item of unique) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log(
  `Repository hygiene check passed (${tracked.length} tracked files checked).`,
);
