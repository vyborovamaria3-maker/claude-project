import { Markup, Telegraf } from "telegraf";
import { getTaskById } from "../../lib/telegram/db";

const frontendUrl = (
  process.env.FRONTEND_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3001"
).replace(/\/$/, "");

function buildMiniAppKeyboard() {
  const miniAppUrl = `${frontendUrl}/miniapp`;
  const openMiniAppButton = frontendUrl.startsWith("https://")
    ? Markup.button.webApp("Открыть Mini App", miniAppUrl)
    : Markup.button.url("Открыть Mini App", miniAppUrl);

  return Markup.inlineKeyboard([
    [openMiniAppButton],
    [Markup.button.url("Войти на сайт", `${frontendUrl}/login`)],
  ]);
}

export function setupStatusHandlers(bot: Telegraf) {
  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = "text" in ctx.message ? ctx.message.text.split(" ") : [];
    const taskId = args?.[1] ? Number.parseInt(args[1], 10) : null;

    if (!taskId) {
      await ctx.reply("Использование: /status <task_id>");
      return;
    }

    const task = getTaskById(taskId);
    if (!task) {
      await ctx.reply(`Задача #${taskId} не найдена.`);
      return;
    }

    if (task.telegram_user_id !== userId) {
      await ctx.reply("У вас нет доступа к этой задаче.");
      return;
    }

    let message = `Статус задачи #${task.id}\n\n`;
    message += `Агент: ${task.agent}\n`;
    message += `Описание: ${task.description}\n`;
    message += `Статус: ${task.status}\n`;
    message += `Приоритет: ${task.priority}\n`;
    message += `Создана: ${new Date(task.created_at).toLocaleString("ru-RU")}\n`;
    message += `Обновлена: ${new Date(task.updated_at).toLocaleString("ru-RU")}\n`;

    if (task.result) {
      message += `\nРезультат:\n${task.result}`;
    }

    if (task.error) {
      message += `\nОшибка:\n${task.error}`;
    }

    await ctx.reply(message);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "Soft777 Bot",
        "",
        "/start - открыть Mini App подписки",
        "/subscribe - оплатить подписку $1000",
        "/agents - список AI агентов",
        "/new - создать задачу",
        "/tasks - список задач",
        "/active - активные задачи",
        "/status <task_id> - статус задачи",
        "/cancel <task_id> - отменить задачу",
      ].join("\n"),
      buildMiniAppKeyboard()
    );
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Открой Mini App, задай логин, оплати подписку $1000 и получи 32-символьный пароль для входа в Solana Launcher.",
      buildMiniAppKeyboard()
    );
  });

  bot.command("auth", async (ctx) => {
    await ctx.reply("Для доступа к софту открой Mini App и оформи подписку.", buildMiniAppKeyboard());
  });

  bot.command("login", async (ctx) => {
    await ctx.reply("Войти на сайт можно после оплаты подписки в Mini App.", buildMiniAppKeyboard());
  });
}
