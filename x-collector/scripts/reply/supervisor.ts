import "dotenv/config";
import { fork, ChildProcess } from "node:child_process";
import path from "node:path";
import { q, closePool } from "../../lib/trade/pg";
import { log } from "../../lib/trade/logger";
const children = new Map<string, ChildProcess>();
const backoff = new Map<string, number>();
let stopping = false;
async function tick() {
  const rows = await q<{ id: string }>(
    "SELECT a.id FROM reply_accounts a JOIN reply_campaigns c ON c.account_id=a.id WHERE a.status='ready' AND c.status='running'",
  );
  const wanted = new Set(rows.map((r) => String(r.id)));
  for (const [id, child] of children)
    if (!wanted.has(id)) child.kill("SIGTERM");
  for (const id of wanted) {
    if (stopping || children.has(id) || (backoff.get(id) ?? 0) > Date.now())
      continue;
    const child = fork(
      path.join(__dirname, "worker" + path.extname(__filename)),
      [id],
      { stdio: "inherit" },
    );
    children.set(id, child);
    const cleanup = () => {
      if (children.get(id) !== child) return;
      children.delete(id);
      backoff.set(id, Date.now() + 30000);
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
  }
}
async function main() {
  while (!stopping) {
    try {
      await tick();
    } catch {
      log.error("reply supervisor cycle failed");
    }
    for (let i = 0; i < 5 && !stopping; i++)
      await new Promise((r) => setTimeout(r, 1000));
  }
  await Promise.all(
    [...children.values()].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        }),
    ),
  );
  await closePool();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    for (const child of children.values()) child.kill("SIGTERM");
  });
main().catch(() => {
  log.error("reply supervisor failed");
  process.exitCode = 1;
});
