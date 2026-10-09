import "dotenv/config";
import { issueToken } from "../../lib/reply/auth";
import { closePool } from "../../lib/trade/pg";
issueToken(process.argv[2] ?? "", Number(process.argv[3] ?? 24))
  .then((token) => console.log(token))
  .catch(() => {
    console.error(
      "Token provisioning failed; check migration, Telegram ID and JWT_SECRET",
    );
    process.exitCode = 1;
  })
  .finally(() => closePool());
