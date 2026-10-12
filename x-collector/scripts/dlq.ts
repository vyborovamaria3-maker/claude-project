import { listDeadLetters, replayDeadLetter } from "../lib/trade/tasks";
import { closePool } from "../lib/trade/pg";

async function main() {
  const [command = "list", id, extra] = process.argv.slice(2);
  if (command === "list") {
    const taskId = id === undefined ? undefined : Number(id);
    if (taskId !== undefined && (!Number.isSafeInteger(taskId) || taskId < 1)) throw new Error("Invalid task ID");
    console.log(JSON.stringify(await listDeadLetters(50, taskId), null, 2));
  } else if (command === "replay") {
    const replayed = await replayDeadLetter(Number(id), extra === undefined ? 1 : Number(extra));
    console.log(JSON.stringify({ replayed }));
    if (!replayed) process.exitCode = 1;
  } else throw new Error("Usage: npm run jobs:dlq -- list [taskId] | replay taskId [extraAttempts]");
}
main().catch(() => { console.error("DLQ operation failed; inspect configuration, task state and database logs"); process.exitCode = 1; }).finally(closePool);
