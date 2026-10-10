import type { ClaimedTask } from "../../lib/trade/tasks";
import { parseTaskPayload } from "../../lib/trade/schemas";
import { decryptBuffer } from "../../lib/trade/crypto";
import { getCollectorAccount, CollectorAccount } from "./account-session";
import { parseProxy } from "./proxy";
import { extractCookies } from "./session";
import { searchX, SearchXOptions } from "./collector";
import type { XTweet } from "./types";

export interface SearchTaskDeps {
  getAccount?: () => Promise<CollectorAccount | null>;
  search?: (query: string, options: SearchXOptions) => Promise<XTweet[]>;
}

/**
 * Адаптер search-задачи для нового X Collector:
 * keyword из payload → аккаунт из x_accounts → decrypt → proxy → searchX.
 * Только чтение БД (аккаунт не резервируется — это зона account-manager).
 */
export async function handleSearchTask(
  task: ClaimedTask,
  deps: SearchTaskDeps = {}
): Promise<XTweet[]> {
  const getAccount = deps.getAccount ?? getCollectorAccount;
  const search = deps.search ?? searchX;

  const payload = parseTaskPayload(task.kind, task.payloadJson) as { query: string; limit: number };

  const account = await getAccount();
  if (!account) throw new Error("no available collector account");

  const decrypted = decryptBuffer(account.session_encrypted);
  let cookies: ReturnType<typeof extractCookies>;
  try {
    cookies = extractCookies(decrypted);
  } finally {
    decrypted.fill(0);
  }

  const proxy=parseProxy(account.proxy_json);
  if(account.proxy_json&&!proxy)throw new Error("PROXY_FAILED: invalid account proxy");
  const tweets = await search(payload.query, {
    cookies,
    proxy,
    userAgent: account.user_agent || undefined,
    timezone: account.timezone || undefined,
    language: account.language || undefined,
    limit: payload.limit,
  });
  return tweets.slice(0, payload.limit);
}
