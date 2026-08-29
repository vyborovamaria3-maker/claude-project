import { getBackendBaseUrl } from "../authProxy";

export async function registerPaidAccess(input: {
  telegramId: number;
  login: string;
  password: string;
  telegramUsername?: string | null;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (process.env.BACKEND_API_KEY) {
    headers["X-API-Key"] = process.env.BACKEND_API_KEY;
  } else if (process.env.NODE_ENV !== "production") {
    headers["X-Dev-Internal"] = "miniapp-subscription";
  }

  const response = await fetch(`${getBackendBaseUrl()}/api/v1/auth/register-password`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      telegram_id: input.telegramId,
      login: input.login,
      password: input.password,
      telegram_username: input.telegramUsername ?? null,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Backend registration failed: ${response.status}`);
  }
}
