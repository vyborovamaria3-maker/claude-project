import "dotenv/config";
import { createHash } from "node:crypto";
import { q, q1, getPool, closePool } from "../../lib/trade/pg";
import { issueToken } from "../../lib/reply/auth";
import { log } from "../../lib/trade/logger";
const allowed = new Set(
  (process.env.REPLY_TELEGRAM_ALLOWED_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v)),
);
const token = process.env.TELEGRAM_BOT_TOKEN;
const tokens = new Map<string, string>();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
async function telegram(method: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
    });
  } catch {
    throw new Error("Telegram transport failed");
  }
  const data = (await response.json()) as { ok: boolean; result: unknown };
  if (!response.ok || !data.ok) throw new Error("Telegram request rejected");
  return data.result;
}
async function send(chat: string, text: string, keyboard?: unknown) {
  await telegram("sendMessage", {
    chat_id: chat,
    text: text.slice(0, 3900),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}
async function backend(
  user: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const jwt = tokens.get(user);
  if (!jwt) throw new Error("Сначала /connect");
  const base = process.env.REPLY_API_URL ?? "http://127.0.0.1:3002";
  const url = new URL("/api" + path, base);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Backend requires HTTPS outside loopback");
  const r = await fetch(url, {
    method,
    headers: { "X-Reply-Token": jwt, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(65000),
  });
  const data = (await r.json()) as { error?: string };
  if (!r.ok) {
    if (r.status === 401) tokens.delete(user);
    throw new Error(data.error ?? "Backend unavailable");
  }
  return data;
}
async function command(user: string, text: string) {
  const [raw, id, ...rest] = text.trim().split(/\s+/);
  const cmd = raw.split("@")[0];
  if (cmd === "/connect") {
    tokens.set(user, await issueToken(user));
    await send(user, "Подключено. /help — команды");
    return;
  }
  if (cmd === "/start" || cmd === "/help") {
    await send(
      user,
      "/connect — подключиться\n/accounts /campaigns /lore /stats /drafts /alerts\n/start_campaign ID /stop_campaign ID\n/pause ID /resume ID /delete_account ID\n/approve ID /reject ID\n/add_lore JSON\n/example LORE_ID JSON\n/source CAMPAIGN_ID JSON\n/filters CAMPAIGN_ID JSON\n/settings CAMPAIGN_ID JSON\n/consent JSON\n/revoke — отозвать доступ бота\nДобавление OAuth-токенов и прокси: защищённый web-интерфейс " +
        (process.env.REPLY_PUBLIC_URL ?? "/reply") +
        " . Не отправляйте секреты в Telegram.",
    );
    return;
  }
  const simple: Record<string, string> = {
    "/accounts": "/accounts",
    "/campaigns": "/campaigns",
    "/lore": "/lore",
    "/stats": "/stats",
    "/alerts": "/alerts",
  };
  if (simple[cmd]) {
    await send(user, JSON.stringify(await backend(user, simple[cmd]), null, 2));
    return;
  }
  if (cmd === "/drafts") {
    const drafts = (await backend(user, "/drafts")) as Array<{
      id: string;
      status: string;
      reply_text: string;
      tweet_json: { text: string };
    }>;
    const review = drafts.filter((d) => d.status === "review").slice(0, 5);
    if (!review.length) {
      await send(user, "Нет черновиков на проверку");
      return;
    }
    for (const draft of review)
      await send(
        user,
        `#${draft.id}\nПост: ${draft.tweet_json.text}\n\nОтвет: ${draft.reply_text}`,
        [
          [
            { text: "Одобрить", callback_data: "/approve " + draft.id },
            { text: "Отклонить", callback_data: "/reject " + draft.id },
          ],
        ],
      );
    return;
  }
  if (cmd === "/revoke") {
    await backend(user, "/token/revoke", "POST", {});
    tokens.delete(user);
    await send(user, "Токен отозван. Новое подключение — /connect");
    return;
  }
  if (["/add_lore", "/consent"].includes(cmd)) {
    const json = text.slice(text.indexOf(" ") + 1);
    await backend(
      user,
      cmd === "/add_lore" ? "/lore" : "/consents",
      "POST",
      JSON.parse(json),
    );
    await send(user, "Сохранено");
    return;
  }
  if (!/^\d+$/.test(id ?? "")) throw new Error("Укажите числовой ID; /help");
  if (cmd === "/start_campaign" || cmd === "/stop_campaign")
    await backend(
      user,
      `/campaigns/${id}/${cmd === "/start_campaign" ? "start" : "stop"}`,
      "POST",
      {},
    );
  else if (cmd === "/pause" || cmd === "/resume")
    await backend(user, `/accounts/${id}`, "PATCH", {
      status: cmd === "/pause" ? "paused" : "ready",
    });
  else if (cmd === "/delete_account")
    await backend(user, `/accounts/${id}`, "DELETE");
  else if (cmd === "/approve" || cmd === "/reject")
    await backend(
      user,
      `/drafts/${id}/${cmd === "/approve" ? "approve" : "reject"}`,
      "POST",
      {},
    );
  else if (["/example", "/source", "/filters", "/settings"].includes(cmd)) {
    const data = JSON.parse(rest.join(" "));
    const endpoint =
      cmd === "/example"
        ? `/lore/${id}/examples`
        : cmd === "/source"
          ? `/campaigns/${id}/sources`
          : cmd === "/filters"
            ? `/campaigns/${id}/filters`
            : `/campaigns/${id}`;
    await backend(
      user,
      endpoint,
      cmd === "/filters" || cmd === "/settings" ? "PATCH" : "POST",
      cmd === "/settings" ? { settings: data } : data,
    );
  } else throw new Error("Неизвестная команда; /help");
  await send(user, "Готово");
}
async function alerts() {
  const rows = await q<{
    id: string;
    telegram_id: string;
    type: string;
    message: string;
  }>(
    "SELECT a.id,u.telegram_id,a.type,a.message FROM reply_alerts a JOIN reply_users u ON u.id=a.user_id WHERE a.delivered_at IS NULL ORDER BY a.created_at LIMIT 20",
  );
  for (const row of rows) {
    if (!allowed.has(row.telegram_id)) continue;
    try {
      await send(row.telegram_id, row.type + ": " + row.message);
      await q("UPDATE reply_alerts SET delivered_at=now() WHERE id=$1", [
        row.id,
      ]);
    } catch {
      break;
    }
  }
}
async function main() {
  if (!token || !allowed.size)
    throw new Error(
      "TELEGRAM_BOT_TOKEN and REPLY_TELEGRAM_ALLOWED_IDS required",
    );
  const lock = await getPool().connect();
  const key =
    "reply-telegram:" + createHash("sha256").update(token).digest("hex");
  try {
    const result = await lock.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)::bigint) locked",
      [key],
    );
    if (!result.rows[0]?.locked) throw new Error("bot already running");
    lock.on("error", () => {
      stopping = true;
    });
    let offset = Number(
      (
        await q1<{ value_json: { offset: number } }>(
          "SELECT value_json FROM reply_service_state WHERE service='telegram'",
        )
      )?.value_json.offset ?? 0,
    );
    while (!stopping) {
      try {
        const updates = (await telegram("getUpdates", {
          offset,
          timeout: 20,
          allowed_updates: ["message", "callback_query"],
        })) as Array<{
          update_id: number;
          message?: {
            chat: { id: number; type: string };
            from?: { id: number };
            text?: string;
          };
          callback_query?: {
            id: string;
            from: { id: number };
            message?: { chat: { id: number; type: string } };
            data?: string;
          };
        }>;
        for (const update of updates) {
          const message = update.message ?? update.callback_query?.message;
          const user = String(
            update.message?.from?.id ?? update.callback_query?.from.id ?? "",
          );
          if (
            message?.chat.type === "private" &&
            String(message.chat.id) === user &&
            allowed.has(user)
          ) {
            try {
              await command(
                user,
                update.message?.text ?? update.callback_query?.data ?? "/help",
              );
            } catch (error) {
              await send(
                user,
                error instanceof SyntaxError
                  ? "Некорректный JSON"
                  : error instanceof Error
                    ? error.message
                    : "Ошибка команды",
              );
            }
            if (update.callback_query)
              await telegram("answerCallbackQuery", {
                callback_query_id: update.callback_query.id,
              });
          }
          offset = update.update_id + 1;
          await q(
            "INSERT INTO reply_service_state(service,value_json) VALUES('telegram',$1::jsonb) ON CONFLICT(service) DO UPDATE SET value_json=EXCLUDED.value_json",
            [JSON.stringify({ offset })],
          );
        }
        await alerts();
      } catch {
        log.error("reply Telegram cycle failed");
        for (let i = 0; i < 5 && !stopping; i++)
          await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    await lock
      .query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key])
      .catch(() => {});
    lock.release();
    await closePool();
  }
}
main().catch(() => {
  log.error("reply Telegram bot stopped; check configuration");
  process.exitCode = 1;
});
