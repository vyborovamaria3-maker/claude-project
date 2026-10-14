import { createRequire } from "node:module";
import type { ScrapeAuthState } from "../../lib/trade/twitter-scraper";
import type { PlaywrightProxy } from "../x/proxy";
import { cookiesFromStorageState } from "./session";
import { createSocks5Fetch } from "./transport";
import { XActionsReadEngine, type ReadClient, type ReadEndpoints, type ReadParsers } from "./engine";

interface HttpModule {
  TwitterHttpClient: new(options: Record<string, unknown>) => ReadClient;
  RateLimitError: new(message: string, options?: { resetAt?: number; status?: number }) => Error;
  GRAPHQL: Record<string, { queryId: string; operationName: string }>;
  parseUserData: ReadParsers["parseUserData"];
  parseTimelineInstructions: ReadParsers["parseTimelineInstructions"];
  userTimelineInstructions: ReadParsers["userTimelineInstructions"];
  parseUserList: NonNullable<ReadParsers["parseUserList"]>;
}

const loader = createRequire(__filename)("../../scripts/xactions-http-loader.cjs") as {
  loadPinnedXActions(root: string): Promise<HttpModule>;
};

/** Fail before any network access if the configured runtime is incompatible. */
export function assertXActionsRuntime(version = process.versions.node): void {
  const parts = version.split(".").map(Number);
  if (parts[0] < 22 || (parts[0] === 22 && (parts[1] < 12 || (parts[1] === 12 && parts[2] < 0)))) {
    throw new Error("XActions 3.5.0 requires Node.js >=22.12 (legacy Playwright remains supported)");
  }
}

export interface HttpRuntimeContext {
  state: ScrapeAuthState;
  proxy: PlaywrightProxy | undefined;
  userAgent?: string;
  signal: AbortSignal;
  beforeRequest: () => Promise<void>;
  root?: string;
  /** Testing seam: no X network calls or local XActions install required. */
  loadModule?: () => Promise<HttpModule>;
}

/**
 * Load the pinned ESM module lazily: the default Playwright path does not
 * evaluate or require XActions. Disable query-ID discovery and transaction
 * signatures to avoid unaccounted background fetches.
 */
export async function createXActionsRuntime(ctx: HttpRuntimeContext): Promise<XActionsReadEngine> {
  assertXActionsRuntime();
  if (!ctx.proxy) throw new Error("PROXY_FAILED: XActions requires an account SOCKS5 proxy");
  const cookieHeader = cookiesFromStorageState(ctx.state);
  const root = ctx.root ?? process.env.XACTIONS_ROOT;
  if (!ctx.loadModule && !root) throw new Error("XActions: XACTIONS_ROOT not configured");
  const module = ctx.loadModule ? await ctx.loadModule() : await loader.loadPinnedXActions(root!);
  const endpoint = (name: string) => {
    const result = module.GRAPHQL[name];
    if (!result || typeof result.queryId !== "string" || !result.queryId ||
      typeof result.operationName !== "string" || !result.operationName) {
      throw new Error(`XActions: required GraphQL operation unavailable: ${name}`);
    }
    return result;
  };
  const endpoints: ReadEndpoints = {
    userByScreenName: endpoint("UserByScreenName"),
    userTweets: endpoint("UserTweets"),
    listTimeline: endpoint("ListTimeline"),
    listMembers: endpoint("ListMembers"),
    searchTimeline: endpoint("SearchTimeline"),
  };
  if (typeof module.userTimelineInstructions !== "function" ||
      typeof module.parseTimelineInstructions !== "function" ||
      typeof module.parseUserList !== "function" ||
      typeof module.parseUserData !== "function" ||
      typeof module.RateLimitError !== "function") {
    throw new Error("XActions: pinned parser exports unavailable");
  }
  const networkFetch = createSocks5Fetch(ctx.proxy);
  // A profile endpoint's budget must not pause unrelated timeline calls.
  const endpointResets = new Map<string, number>();
  const proxiedFetch: typeof fetch = async (input, init) => {
    ctx.signal.throwIfAborted();
    const inputUrl = typeof input === "string" || input instanceof URL ? input : null;
    if (!inputUrl) throw new Error("XActions: only URL requests supported");
    const url = new URL(inputUrl);
    if (url.protocol !== "https:" || (url.hostname !== "x.com" && !url.hostname.endsWith(".x.com"))) {
      throw new Error("XActions: HTTP request target is not x.com");
    }
    // Proactively respect X's per-endpoint remaining/reset header once it
    // reaches zero. The upstream client recognizes its own RateLimitError and
    // will not re-try or convert it into a generic NetworkError.
    const now = Date.now();
    const reset = endpointResets.get(url.pathname) ?? 0;
    if (reset > now) {
      throw new module.RateLimitError("XActions endpoint request budget exhausted", {
        status: 429, resetAt: reset,
      });
    }
    await ctx.beforeRequest();
    ctx.signal.throwIfAborted();
    try {
      return await networkFetch(input, { ...init, signal: ctx.signal });
    } catch {
      ctx.signal.throwIfAborted();
      // Do not forward transport/agent messages that could contain proxy secrets.
      throw new Error("PROXY_FAILED: XActions SOCKS5 transport request failed");
    }
  };
  const client = new module.TwitterHttpClient({
    cookies: cookieHeader, userAgent: ctx.userAgent,
    fetch: proxiedFetch, maxRetries: 0, rateLimitStrategy: "error",
    autoRefreshQueryIds: false, transactionId: false,
    onResponse: (response: { url?: string; status: number; remaining: number | null; resetAt: number | null }) => {
      // The X rate-limit headers are per GraphQL operation. Never apply a
      // UserByScreenName reset to an unrelated ListTimeline request.
      if (!response.url) return;
      let pathname: string;
      try { pathname = new URL(response.url).pathname; } catch { return; }
      if (response.remaining !== 0) {
        if (response.remaining !== null && response.remaining > 0) endpointResets.delete(pathname);
        return;
      }
      if (typeof response.resetAt === "number" &&
          Number.isFinite(response.resetAt) && response.resetAt > Date.now()) {
        endpointResets.set(pathname, Math.min(response.resetAt, Date.now() + 86_400_000));
      }
    },
  });
  return new XActionsReadEngine(client, endpoints, {
    parseUserData: module.parseUserData,
    parseTimelineInstructions: module.parseTimelineInstructions,
    userTimelineInstructions: module.userTimelineInstructions,
    parseUserList: module.parseUserList,
  });
}
