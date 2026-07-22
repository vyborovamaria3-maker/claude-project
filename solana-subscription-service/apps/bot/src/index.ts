import "dotenv/config";
import { PrismaClient, SubscriptionStatus } from "@prisma/client";
import { Markup, Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.TELEGRAM_WEBAPP_URL ?? process.env.WEB_PUBLIC_URL ?? "http://localhost:3000";

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const bot = new Telegraf(token);
const prisma = new PrismaClient();
const isLocalPlaceholderToken = token.includes("local-dev-placeholder-token");

const openAppKeyboard = Markup.inlineKeyboard([
  Markup.button.webApp("Open SolSub", webAppUrl)
]);

bot.start(async (ctx) => {
  await ctx.reply(
    "Welcome to SolSub. Open the app, sign in with Telegram, link a Solana wallet and choose a subscription.",
    openAppKeyboard
  );
});

bot.command("status", async (ctx) => {
  const user = await findUser(ctx.from.id);
  if (!user) {
    await ctx.reply("Open the app first so I can link this chat to your account.", openAppKeyboard);
    return;
  }

  const subscription = await prisma.subscription.findFirst({
    where: { userId: user.id },
    include: { plan: true },
    orderBy: { updatedAt: "desc" }
  });

  if (!subscription) {
    await ctx.reply("No subscription yet.", openAppKeyboard);
    return;
  }

  await ctx.reply(
    `Plan: ${subscription.plan.name}\nStatus: ${subscription.status}\nEnds: ${subscription.endsAt?.toISOString().slice(0, 10) ?? "n/a"}`,
    openAppKeyboard
  );
});

bot.command("upgrade", async (ctx) => {
  await ctx.reply("Choose a new plan in the Mini App.", openAppKeyboard);
});

bot.command("cancel", async (ctx) => {
  const user = await findUser(ctx.from.id);
  if (!user) {
    await ctx.reply("Open the app first so I can link this chat to your account.", openAppKeyboard);
    return;
  }

  await prisma.subscription.updateMany({
    where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
    data: { status: SubscriptionStatus.CANCELED }
  });
  await ctx.reply("Your subscription is canceled. Renew anytime from the Mini App.", openAppKeyboard);
});

bot.catch((error) => {
  console.error("Telegram bot error", error);
});

async function findUser(telegramId: number) {
  return prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
}

async function startBot() {
  if (isLocalPlaceholderToken) {
    console.warn("SolSub Telegram bot is running in local placeholder mode. Set a real TELEGRAM_BOT_TOKEN to enable Telegram access.");
    return;
  }

  try {
    await bot.launch();
    console.log("SolSub Telegram bot started");
  } catch (error) {
    console.error("Telegram bot failed to launch", error);
    console.warn("Keeping the bot container alive in disabled mode so local dev can continue.");
  }
}

void startBot();

if (isLocalPlaceholderToken) {
  setInterval(() => {
    // Keep the container alive in dev placeholder mode.
  }, 60_000);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function shutdown(signal: string) {
  bot.stop(signal);
  await prisma.$disconnect();
}
