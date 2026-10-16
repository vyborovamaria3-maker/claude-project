import { telegramWaitSeconds } from "../validation.js";

export type RetryDecision =
  | { action: "delay"; code: string; seconds: number; global: boolean }
  | { action: "failed"; code: string }
  | { action: "halt"; code: string; scope: "account" | "session" };

/**
 * Never evade Telegram restrictions: PeerFlood halts the account;
 * revoked credentials require interactive reauthorization.
 */
export function classifyTelegramError(error: unknown, attempts: number): RetryDecision {
  const typed = error as { message?: unknown; errorMessage?: unknown; code?: unknown; seconds?: unknown } | null;
  const text = [typed?.errorMessage, typed?.message, String(error)].map(String).join(" ").toUpperCase();
  if (/PEER[_ ]?FLOOD|USER_RESTRICTED|USER_BANNED_IN_CHANNEL/.test(text)) {
    return { action: "halt", code: "TG_ACCOUNT_RESTRICTED", scope: "account" };
  }
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|USER_DEACTIVATED_BAN/.test(text)) {
    return { action: "halt", code: "TG_SESSION_INVALID", scope: "session" };
  }
  const slowmode = text.match(/SLOWMODE_WAIT_?([0-9]+)/);
  if (slowmode) return {
    action: "delay", code: "TG_SLOWMODE_WAIT",
    seconds: Math.min(Number(slowmode[1])+15, 30*86400), global: false,
  };
  if (/FLOOD_WAIT/i.test(text) || (Number(typed?.code) === 420 && typeof typed?.seconds === "number")) {
    const seconds = telegramWaitSeconds(error);
    if (seconds && seconds > 0) {
      return { action: "delay", code: "TG_FLOOD_WAIT", seconds: Math.min(seconds+15, 30*86400), global: true };
    }
    return { action: "halt", code: "TG_RATE_LIMIT_UNKNOWN", scope: "account" };
  }
  if (/CHANNEL_PRIVATE|USERNAME_INVALID|USERNAME_NOT_OCCUPIED|CHAT_ADMIN_REQUIRED|USER_NOT_PARTICIPANT|TG_SOURCE_UNSUPPORTED/.test(text)) {
    return { action: "failed", code: "TG_SOURCE_INACCESSIBLE" };
  }
  if (attempts >= 5) return { action: "failed", code: "TG_RETRY_EXHAUSTED" };
  return { action: "delay", code: "TG_TRANSIENT_ERROR", seconds: Math.min(900, 15 * 2 ** attempts), global: false };
}
