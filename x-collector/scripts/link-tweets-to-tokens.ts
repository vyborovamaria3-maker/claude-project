import { closePool } from "../lib/trade/pg";
import { linkTweetsToKnownTokens, loadKnownTokenMints, resetTweetTokenLinkerState } from "../src/intelligence/tweet-token-linker";

async function main() {
  const args = process.argv.slice(2);
  const batchIndex = args.indexOf("--batch-size");
  const batchSize = Number(batchIndex >= 0 ? args[batchIndex + 1] : process.env.TWEET_TOKEN_LINK_BATCH_SIZE ?? 250);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("--batch-size must be an integer between 1 and 1000");
  }
  if (args.includes("--rebuild")) {
    const reset = await resetTweetTokenLinkerState();
    console.log("Reset linker state for " + reset + " tweet(s); existing links were preserved.");
  }
  const knownMints = await loadKnownTokenMints();
  if (knownMints.size === 0) {
    console.log("No known token mints found in archive_tokens or Solana ip_entities; no tweets were marked processed.");
    return;
  }
  const processAll = args.includes("--all");
  let scanned = 0;
  let linksWritten = 0;
  let batches = 0;
  do {
    const result = await linkTweetsToKnownTokens(batchSize, knownMints);
    console.log(JSON.stringify(result));
    if (result.registryEmpty) break;
    if (result.scanned === 0) break;
    scanned += result.scanned;
    linksWritten += result.linksWritten;
    batches++;
  } while (processAll);
  console.log("Linker finished: scanned=" + scanned + ", links_written=" + linksWritten + ", batches=" + batches);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "tweet token linker failed");
  process.exitCode = 1;
}).finally(async () => {
  await closePool().catch(() => {});
});