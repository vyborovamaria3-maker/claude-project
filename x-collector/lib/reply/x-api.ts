import { requestJSON, ProxyConfig } from "./proxy";
import { unseal } from "./secrets";
import type { Account, Tweet } from "./model";
export class XError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAt: number | null = null,
  ) {
    super("X API HTTP " + status);
  }
}
export class PublishUncertainError extends Error {
  constructor() {
    super("publication outcome unknown; reconcile before retry");
  }
}
export interface Credentials {
  access_token: string;
  refresh_token?: string;
}
interface RawTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  public_metrics?: { like_count?: number; retweet_count?: number; repost_count?: number };
  referenced_tweets?: Array<{ type: string; id: string }>;
  referenced_posts?: Array<{ type: string; id: string }>;
  attachments?: { media_keys: string[] };
}
interface XPage {
  data?: RawTweet[];
  includes?: {
    users?: Array<{
      id: string;
      username: string;
      public_metrics?: { followers_count: number };
    }>;
    media?: Array<{ media_key: string; type: string; url?: string }>;
  };
  meta?: { newest_id?: string; next_token?: string };
}
export function postFields(): string {
  return process.env.REPLY_X_FIELD_DIALECT === "tweets"
    ? "tweet.fields=author_id,created_at,public_metrics,referenced_tweets,attachments"
    : "post.fields=created_at,public_metrics,attachments&expansions=author_id,referenced_posts";
}
export class XClient {
  constructor(
    private credentials: Credentials,
    private proxy?: ProxyConfig,
    private transport: typeof requestJSON = requestJSON,
  ) {}
  static fromAccount(account: Account): XClient {
    return new XClient(
      unseal<Credentials>(account.credentials_encrypted),
      account.proxy_encrypted
        ? unseal<ProxyConfig>(account.proxy_encrypted)
        : undefined,
    );
  }
  async call(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const result = await this.transport(new URL(path, "https://api.x.com"), {
      method,
      body,
      proxy: this.proxy,
      headers: { Authorization: "Bearer " + this.credentials.access_token },
      timeoutMs: 15000,
    });
    if (result.status < 200 || result.status >= 300) {
      const reset = Number(result.headers["x-rate-limit-reset"]);
      throw new XError(
        result.status,
        Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
      );
    }
    return result.data;
  }
  async me(): Promise<{ id: string; username: string }> {
    const result = (await this.call("/2/users/me")) as {
      data?: { id: string; username: string };
    };
    if (!result.data?.id || !result.data.username)
      throw new Error("X account verification failed");
    return result.data;
  }
  async source(
    type: "search" | "list",
    value: string,
    sinceId?: string | null,
    pageToken?: string | null,
  ): Promise<{ tweets: Tweet[]; newestId?: string; nextToken?: string }> {
    const legacy = process.env.REPLY_X_FIELD_DIALECT === "tweets";
    const params = new URLSearchParams(postFields());
    params.set("expansions", "author_id,attachments.media_keys," +
      (legacy ? "referenced_tweets" : "referenced_posts"));
    params.set("user.fields", "username,public_metrics");
    params.set("media.fields", "url,type");
    params.set("max_results", "100");
    // List timelines have no since_id parameter; apply the watermark locally.
    if (sinceId && type === "search") params.set("since_id", sinceId);
    if (pageToken)
      params.set(
        type === "search" ? "next_token" : "pagination_token",
        pageToken,
      );
    const path =
      type === "search"
        ? "/2/tweets/search/recent"
        : "/2/lists/" + encodeURIComponent(value) + "/tweets";
    if (type === "search") params.set("query", value);
    const result = (await this.call(path + "?" + params)) as XPage;
    const users = new Map(result.includes?.users?.map((u) => [u.id, u]) ?? []);
    const media = new Map(
      result.includes?.media?.map((m) => [m.media_key, m]) ?? [],
    );
    const rows = result.data ?? [];
    const newer = rows.filter((t) => !sinceId || BigInt(t.id) > BigInt(sinceId));
    const tweets = newer.map((t) => {
      const user = users.get(t.author_id);
      const refs = t.referenced_posts ?? t.referenced_tweets ?? [];
      return {
        id: t.id,
        text: t.text,
        author_id: t.author_id,
        username: user?.username ?? "",
        created_at: t.created_at,
        likes: t.public_metrics?.like_count ?? 0,
        retweets: t.public_metrics?.repost_count ?? t.public_metrics?.retweet_count ?? 0,
        followers: user?.public_metrics?.followers_count ?? 0,
        is_reply: refs.some((r) => r.type === "replied_to"),
        is_retweet: refs.some((r) => ["retweeted", "reposted"].includes(r.type)),
        is_quote: refs.some((r) => r.type === "quoted"),
        images: (t.attachments?.media_keys ?? []).flatMap((k) => {
          const m = media.get(k);
          return m?.type === "photo" && m.url ? [m.url] : [];
        }),
      };
    });
    return {
      tweets,
      newestId: result.meta?.newest_id ?? newer.reduce<string | undefined>((id, t) => !id || BigInt(t.id) > BigInt(id) ? t.id : id, undefined),
      nextToken: type === "list" && newer.length < rows.length ? undefined : result.meta?.next_token,
    };
  }
  async publish(tweetId: string, text: string): Promise<string> {
    let result: unknown;
    // Never blindly retry POST: a disconnect or 5xx may occur after creation.
    try {
      result = await this.call("/2/tweets", "POST", {
        text,
        reply: { in_reply_to_tweet_id: tweetId },
      });
    } catch (error) {
      if (error instanceof XError && error.status < 500) throw error;
      throw new PublishUncertainError();
    }
    const id = (result as { data?: { id?: string } }).data?.id;
    if (!id) throw new PublishUncertainError();
    return id;
  }
}
