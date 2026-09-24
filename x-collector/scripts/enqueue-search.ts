import { enqueueTask } from "../lib/trade/tasks";
import { SearchPayload, SolanaMint } from "../lib/trade/schemas";
import { closePool } from "../lib/trade/pg";

function parseArgs(argv: string[]) {
  const query = argv[0];
  if (!query) {
    throw new Error('Usage: npx ts-node scripts/enqueue-search.ts "query" [--limit 50] [--sort latest|top] [--mint ADDRESS] [--priority 0]');
  }
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    flags[key] = inline ?? argv[++i] ?? "true";
  }
  return { query, flags };
}

async function main() {
  try {
    const { query, flags } = parseArgs(process.argv.slice(2));
    const payload = SearchPayload.parse({
      query,
      limit: Number(flags.limit ?? 50),
      sort: flags.sort ?? "latest",
    });
    const mint = flags.mint ?? null;
    if (mint && !SolanaMint.safeParse(mint).success) {
      throw new Error("--mint must be a valid Solana mint address");
    }
    const priority = Number(flags.priority ?? 0);
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
      throw new Error("--priority must be an integer from -100 to 100");
    }

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
