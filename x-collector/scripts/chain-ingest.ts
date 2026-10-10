import fs from "node:fs";
import path from "node:path";
import { parseArgv, intFlag } from "../lib/trade/cli";
import { closePool, tx } from "../lib/trade/pg";
import { ingestTransaction } from "../lib/trade/intelligence-blockchain";
import { SUPPORTED_CHAINS, assertSupportedChain } from "../lib/intelligence/chain-adapter";

type UnknownRecord = Record<string, unknown>;

function parseArgs(argv: string[]) {
  const { flags, positional } = parseArgv(argv);
  const input = flags.input ?? flags.i ?? positional[0];
  if (!input) {
    throw new Error(
      "Usage: npm run chain:ingest -- --input <transactions.json> [--limit N] [--dry-run]",
    );
  }
  return {
    inputPath: path.resolve(process.cwd(), input),
    limit: intFlag(flags, "limit", 1000, 1, 100_000),
    dryRun: flags["dry-run"] === "true",
  };
}

function readTransactions(filePath: string): UnknownRecord[] {
  if (!fs.existsSync(filePath)) throw new Error("Transaction file not found: " + filePath);
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8").replace(String.fromCharCode(0xfeff), ""));
  if (!Array.isArray(parsed)) throw new Error("Transaction file must contain a JSON array");
  return parsed.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Transaction #${index} is not a JSON object`);
    }
    return row as UnknownRecord;
  });
}

function validateChain(row: UnknownRecord, index: number): string {
  const chain = row.chain;
  if (typeof chain !== "string") throw new Error(`Transaction #${index} is missing "chain"`);
  return assertSupportedChain(chain);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = readTransactions(options.inputPath).slice(0, options.limit);
  const chains = new Set<string>();
  for (const [index, row] of rows.entries()) chains.add(validateChain(row, index));

  if (options.dryRun) {
    console.log(`[x-collector:chain-ingest] dry-run ok: ${rows.length} transactions, chains=${[...chains].join(",")}`);
    return;
  }

  let ingested = 0;
  const failures: string[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      await tx(async (client) => {
        await ingestTransaction(client, row);
      });
      ingested += 1;
    } catch (error) {
      failures.push(`#${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `[x-collector:chain-ingest] ingested=${ingested}/${rows.length} chains=${[...chains].join(",")} supported=${SUPPORTED_CHAINS.join(",")}`,
  );
  if (failures.length) {
    for (const failure of failures) console.error(`[x-collector:chain-ingest] failed ${failure}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("[x-collector:chain-ingest]", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
