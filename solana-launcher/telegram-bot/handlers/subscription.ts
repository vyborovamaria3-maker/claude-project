import { Markup, Telegraf } from "telegraf";

const frontendUrl = (
  process.env.FRONTEND_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3001"
).replace(/\/$/, "");

function miniAppKeyboard() {
  const miniAppUrl = `${frontendUrl}/miniapp`;
  const button = frontendUrl.startsWith("https://")
    ? Markup.button.webApp("Open Mini App", miniAppUrl)
    : Markup.button.url("Open Mini App", miniAppUrl);

  return Markup.inlineKeyboard([[button]]);
}

export function setupSubscriptionHandlers(bot: Telegraf) {
  bot.command("subscribe", async (ctx) => {
    await ctx.reply(
      "Open the Mini App to activate access. Paid subscriptions support SOL and USDT on the Solana network; the administrator can also enable free demo access.",
      miniAppKeyboard()
    );
  });
}
