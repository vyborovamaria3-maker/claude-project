import { searchX } from "../src/x/collector";

async function main() {
  console.log('[test-x] searchX("bitcoin")...');
  const tweets = await searchX("bitcoin");
  console.log(JSON.stringify(tweets.slice(0, 3), null, 2));
}

main().catch((e) => {
  console.error("[test-x] ошибка:", e instanceof Error ? e.message : e);
  process.exit(1);
});
