import "dotenv/config";
import { tx, closePool } from "../../lib/trade/pg";
import { seal, unseal } from "../../lib/reply/secrets";
// Set REPLY_ENCRYPTION_KEYS to include both old and new IDs, and select new active ID.
// Do not remove old key until every service has restarted and this transaction commits.
tx(async (c) => {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('reply-key-rotation'))");
  const rows = await c.query<{
    id: string;
    credentials_encrypted: string;
    proxy_encrypted: string | null;
  }>(
    "SELECT id,credentials_encrypted,proxy_encrypted FROM reply_accounts FOR UPDATE",
  );
  for (const row of rows.rows)
    await c.query(
      "UPDATE reply_accounts SET credentials_encrypted=$1,proxy_encrypted=$2 WHERE id=$3",
      [
        seal(unseal(row.credentials_encrypted)),
        row.proxy_encrypted ? seal(unseal(row.proxy_encrypted)) : null,
        row.id,
      ],
    );
  return rows.rowCount;
})
  .then((count) => console.log("Rotated account records:", count))
  .catch(() => {
    console.error("Key rotation rolled back; retain previous keys");
    process.exitCode = 1;
  })
  .finally(() => closePool());
