import { enqueueTask } from "../lib/trade/tasks";
import { SearchPayload, SolanaMint } from "../lib/trade/schemas";
import { closePool } from "../lib/trade/pg";
import { parseArgv, intFlag, enumFlag } from "../lib/trade/cli";

function parseArgs(argv: string[]) {
  const { positional, flags } = parseArgv(argv);
  const query = positional[0];
  if (!query) {
    throw new Error('Usage: npx ts-node scripts/enqueue-search.ts "query" [--limit 50] [--sort latest|top] [--mint ADDRESS] [--priority 0]');
  }
  return { query, flags };
}

async function main() {
  try {
    const { query, flags } = parseArgs(process.argv.slice(2));
    const payload = SearchPayload.parse({
      query,
      limit: intFlag(flags, "limit", 50, 1, 500),
      sort: enumFlag(flags, "sort", "latest", ["latest", "top"] as const),
    });
    const mint = flags.mint ?? null;
    if (mint && !SolanaMint.safeParse(mint).success) {
      throw new Error("--mint must be a valid Solana mint address");
    }
    const priority = intFlag(flags, "priority", 0, -100, 100);

    const id = await enqueueTask({
      kind: "search", payload, mint, priority, dedup: false,
    });
    if (id === null) throw new Error("Task enqueue failed");
    console.log(`Queued search task #${id} (${payload.sort}, limit=${payload.limit})${mint ? ` for mint ${mint}` : ""}`);
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
