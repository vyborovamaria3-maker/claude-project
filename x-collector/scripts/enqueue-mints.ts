import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { enqueueTasks } from "../lib/trade/tasks";
import { closePool } from "../lib/trade/pg";
import { parseArgv, intFlag, enumFlag } from "../lib/trade/cli";

function parseArgs(argv: string[]) {
  const { flags } = parseArgv(argv);
  const input = flags.input ?? flags.i;
  if (!input) throw new Error("Usage: npm run x-collector:search-mints -- --input path\\to\\mints.txt [--limit 50] [--sort latest|top]");
  const limit = intFlag(flags, "limit", 50, 1, 500);
  const sort = enumFlag(flags, "sort", "latest", ["latest", "top"] as const);
  const priority = intFlag(flags, "priority", 0, -100, 100);
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

const BATCH = 500;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mints = readMints(options.inputPath);
  let queued = 0;
  let alreadyQueued = 0;

  // Пакетная вставка: один round-trip на BATCH минтов вместо одного на минт.
  for (let offset = 0; offset < mints.length; offset += BATCH) {
    const chunk = mints.slice(offset, offset + BATCH);
    const r = await enqueueTasks(chunk.map((mint) => ({
      kind: "search" as const,
      payload: { query: mint, limit: options.limit, sort: options.sort },
      mint,
      priority: options.priority,
      dedup: true,
    })));
    queued += r.queued;
    alreadyQueued += r.duplicates;
    console.log(`[x-collector] ${Math.min(offset + BATCH, mints.length)}/${mints.length} queued=${r.queued} alreadyQueued=${r.duplicates}`);
  }
  console.log("[x-collector] done: queued=" + queued + ", alreadyQueued=" + alreadyQueued + ", total=" + mints.length);
}

main()
  .catch((error) => {
    console.error("[x-collector:enqueue-mints]", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
