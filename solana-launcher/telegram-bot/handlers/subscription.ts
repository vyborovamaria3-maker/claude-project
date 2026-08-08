import { Markup, Telegraf } from "telegraf";
import { generateAccessPassword } from "../../lib/telegram/access";
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
    const query = ctx.preCheckoutQuery;
    const order = await getSubscriptionOrder(query.invoice_payload);
    const valid =
      order &&
      order.status === "pending" &&
      query.currency === "USD" &&
      query.total_amount === order.amount_usd * 100;

    if (!valid) {
      await ctx.answerPreCheckoutQuery(
        false,
        "This payment order is invalid or expired. Please create a new invoice from the Mini App."
      );
      return;
    }

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

    const order = await getSubscriptionOrder(payment.invoice_payload);
    if (!order) {
      await ctx.reply("Payment received, but the order was not found. Please contact the administrator.");
      return;
    }

    if (payment.currency !== "USD" || payment.total_amount !== order.amount_usd * 100) {
      console.error("[Telegram Payment] Amount or currency mismatch", {
        payload: payment.invoice_payload,
        currency: payment.currency,
        totalAmount: payment.total_amount,
        expectedAmount: order.amount_usd * 100,
      });
      await ctx.reply("Payment data did not match the order. Access was not changed; please contact the administrator.");
      return;
    }

    if (order.status === "paid" && order.password) {
      await ctx.reply(
        `Access is already active.\n\nLogin: ${order.login}\nPassword: ${order.password}`,
        Markup.inlineKeyboard([[Markup.button.url("Sign in to site", `${frontendUrl}/login`)]])
      );
      return;
    }

    const password = generateAccessPassword();
    const completed = await markSubscriptionPaid({
      payload: order.payload,
      password,
      providerChargeId: payment.provider_payment_charge_id,
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
    });

    const accessPassword = completed.password || password;
    const message = completed.already_paid
      ? `Access is already active.\n\nLogin: ${completed.login}\nPassword: ${accessPassword}`
      : `Payment confirmed. Access is active for 30 days.\n\nLogin: ${completed.login}\nPassword: ${accessPassword}\n\nUse these credentials to sign in to the site.`;

    await ctx.reply(
      message,
      Markup.inlineKeyboard([[Markup.button.url("Sign in to site", `${frontendUrl}/login`)]])
    );
  });
}
