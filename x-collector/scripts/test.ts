import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
const load = createRequire(__filename);
const bundled = load("@sparticuz/chromium").default as typeof import("@sparticuz/chromium").default;
async function main() {
  // Extract once before parallel test processes can open/write the same binary.
  const executablePath = process.env.TEST_CHROMIUM_PATH ?? (process.platform === "linux" ? await bundled.executablePath() : chromium.executablePath());
  const files = (await fs.readdir("tests")).filter(f => f.endsWith(".test.ts")).sort().map(f => "tests/" + f);
  const concurrency = Number(process.env.TEST_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid TEST_CONCURRENCY");
  const child = spawn(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...files], {
    stdio: "inherit", env: { ...process.env, TEST_CHROMIUM_PATH: executablePath },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); });
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
