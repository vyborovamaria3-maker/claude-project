import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { enqueueTask } from "../lib/trade/tasks";
import { closePool } from "../lib/trade/pg";

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error("Unexpected argument: " + arg);
    const [key, ...inline] = arg.slice(2).split("=");
    const value = inline.length
      ? inline.join("=")
      : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    flags.set(key, value);
  }
  const input = flags.get("input") ?? flags.get("i");
  if (!input) throw new Error("Usage: npm run x-collector:search-mints -- --input path\\to\\mints.txt [--limit 50] [--sort latest|top]");
  const limit = Number(flags.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be an integer from 1 to 500");
  const sort = flags.get("sort") ?? "latest";
  if (sort !== "latest" && sort !== "top") throw new Error("--sort must be latest or top");
  const priority = Number(flags.get("priority") ?? 0);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new Error("--priority must be an integer from -100 to 100");
  return { inputPath: path.resolve(process.cwd(), input), limit, sort, priority };
}

function readMints(filePath: string): string[] {
  if (!fs.existsSync(filePath)) throw new Error("Mint list not found: " + filePath);
  const source = fs.readFileSync(filePath, "utf8").replace(String.fromCharCode(0xfeff), "");
  const mints = new Set<string>();
  const invalid: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const address = line.split("#", 1)[0].trim().split(/[\s,;]+/, 1)[0];
    if (!address) continue;
    try {
      const canonical = new PublicKey(address).toBase58();
      if (canonical !== address) invalid.push(address);
      else mints.add(canonical);
    } catch {
      invalid.push(address);
    }
  }
  if (invalid.length) throw new Error("Invalid Solana address(es): " + invalid.slice(0, 10).join(", "));
  if (mints.size === 0) throw new Error("No mint addresses found in the input file");
  return [...mints];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mints = readMints(options.inputPath);
  let queued = 0;
  let alreadyQueued = 0;
  for (const [index, mint] of mints.entries()) {
    const id = await enqueueTask({
      kind: "search",
      payload: { query: mint, limit: options.limit, sort: options.sort },
      mint,
      priority: options.priority,
      dedup: true,
    });
    if (id == null) alreadyQueued += 1;
    else queued += 1;
    console.log("[x-collector] " + (index + 1) + "/" + mints.length + " " + mint + ": " + (id == null ? "already queued" : "task " + id));
  }
  console.log("[x-collector] done: queued=" + queued + ", alreadyQueued=" + alreadyQueued + ", total=" + mints.length);
}

main()
  .catch((error) => {
    console.error("[x-collector:enqueue-mints]", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
