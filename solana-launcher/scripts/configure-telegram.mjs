const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = (
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.FRONTEND_URL ||
  ""
).replace(/\/$/, "");
const webhookUrl = (
  process.env.TELEGRAM_WEBHOOK_URL ||
  (appUrl ? `${appUrl}/api/telegram/webhook` : "")
).replace(/\/$/, "");

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
if (!appUrl.startsWith("https://")) throw new Error("NEXT_PUBLIC_APP_URL must use HTTPS");
if (!webhookUrl.startsWith("https://")) throw new Error("TELEGRAM_WEBHOOK_URL must use HTTPS");

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`${method} failed: ${payload.description || response.status}`);
  }
  return payload.result;
}

await telegram("setWebhook", {
  url: webhookUrl,
  ...(process.env.TELEGRAM_WEBHOOK_SECRET
    ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET }
    : {}),
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
});

await telegram("setChatMenuButton", {
  menu_button: {
    type: "web_app",
    text: "Open Mini App",
    web_app: { url: `${appUrl}/miniapp` },
  },
});

await telegram("setMyCommands", {
  commands: [
    { command: "start", description: "Open Mini App" },
    { command: "subscribe", description: "Open subscription" },
    { command: "help", description: "Show help" },
    { command: "agents", description: "List AI agents" },
    { command: "tasks", description: "List your tasks" },
  ],
});

const webhook = await telegram("getWebhookInfo", {});
console.log(`Telegram webhook configured: ${webhook.url}; pending updates: ${webhook.pending_update_count}`);
