import { Markup, Telegraf } from "telegraf";
import { generateAccessPassword } from "../../lib/telegram/access";
import { registerPaidAccess } from "../../lib/telegram/register-access";
import {
  getSubscriptionOrder,
  markSubscriptionPaid,
} from "../../lib/telegram/subscription-store";

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
      "Open the Mini App, choose your login, pay the $1000 subscription, and receive a 32-character password for site access.",
      miniAppKeyboard()
    );
  });

  bot.on("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckoutQuery(true);
  });

  bot.on("successful_payment", async (ctx) => {
    const payment = (ctx.message as any).successful_payment as {
      invoice_payload: string;
      provider_payment_charge_id?: string;
      telegram_payment_charge_id?: string;
      total_amount?: number;
      currency?: string;
    };

    const order = getSubscriptionOrder(payment.invoice_payload);
    if (!order) {
      await ctx.reply("Payment received, but the order was not found. Please contact the administrator.");
      return;
    }

    if (order.status === "paid" && order.password) {
      await ctx.reply(`Access is already active.\n\nLogin: ${order.login}\nPassword: ${order.password}`);
      return;
    }

    const password = generateAccessPassword();
    await registerPaidAccess({
      telegramId: order.telegram_user_id,
      login: order.login,
      password,
      telegramUsername: order.username,
    });

    markSubscriptionPaid({
      payload: order.payload,
      password,
      providerChargeId: payment.provider_payment_charge_id,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
    });

    await ctx.reply(
      `Payment confirmed. Access is active for 30 days.\n\nLogin: ${order.login}\nPassword: ${password}\n\nUse these credentials to sign in to the site.`,
      Markup.inlineKeyboard([[Markup.button.url("Sign in to site", `${frontendUrl}/login`)]])
    );
  });
}
