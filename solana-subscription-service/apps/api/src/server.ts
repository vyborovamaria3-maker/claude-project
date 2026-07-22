import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { errorHandler } from "./middleware/error-handler";
import authRoutes from "./routes/auth.routes";
import planRoutes from "./routes/plan.routes";
import walletRoutes from "./routes/wallet.routes";
import subscriptionRoutes from "./routes/subscription.routes";
import premiumRoutes from "./routes/premium.routes";
import webhookRoutes from "./routes/webhook.routes";
import { scheduleRecurringJobs, startMaintenanceWorker } from "./jobs/subscription.jobs";

const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin: env.WEB_ORIGIN,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const sensitiveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

app.get("/health", (_req, res) => res.json({ ok: true, app: env.APP_NAME }));
app.use("/api/auth", sensitiveLimiter, authRoutes);
app.use("/api/wallet", sensitiveLimiter, walletRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/subscription", sensitiveLimiter, subscriptionRoutes);
app.use("/api/premium", premiumRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use(errorHandler);

async function main() {
  await scheduleRecurringJobs();
  const worker = startMaintenanceWorker();
  const server = app.listen(env.PORT, () => {
    console.log(`${env.APP_NAME} API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await worker.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
