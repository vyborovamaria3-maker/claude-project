import "dotenv/config";
import http from "node:http";
import { handleReplyRequest } from "../../lib/reply/http";
import {
  applySecurityHeaders,
  createRateLimiter,
  clientIp,
} from "../../lib/trade/http-security";
import { closePool } from "../../lib/trade/pg";
const allow = createRateLimiter(120);
const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  if (!allow(clientIp(req))) {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: "too many requests" }));
    return;
  }
  try {
    if (!(await handleReplyRequest(req, res))) {
      res.statusCode = 404;
      res.end();
    }
  } catch {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "internal server error" }));
  }
});
const port = Number(process.env.REPLY_API_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("invalid REPLY_API_PORT");
server.listen(port, process.env.REPLY_API_HOST ?? "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      void closePool().then(() => process.exit(0));
    }),
  );
