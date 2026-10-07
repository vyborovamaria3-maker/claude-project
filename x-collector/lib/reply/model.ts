import { z } from "zod";
export const Settings = z
  .object({
    hourly_limit: z.number().int().min(1).max(30).default(15),
    daily_limit: z.number().int().min(1).max(1000).default(250),
    delay_seconds: z.number().int().min(15).max(3600).default(30),
    sleep_start: z.number().int().min(0).max(23).default(1),
    sleep_end: z.number().int().min(0).max(23).default(8),
    sleep_enabled: z.boolean().default(true),
    auto_publish: z.boolean().default(false),
  })
  .strict();
export const Filters = z
  .object({
    min_age: z.number().min(0).max(1440).default(1),
    max_age: z.number().min(1).max(10080).default(10),
    skip_replies: z.boolean().default(true),
    skip_retweets: z.boolean().default(true),
    skip_quotes: z.boolean().default(false),
    min_likes: z.number().int().nonnegative().default(0),
    min_retweets: z.number().int().nonnegative().default(0),
    min_followers: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine((v) => v.min_age <= v.max_age, "min_age must not exceed max_age");
export const LoreInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    country: z
      .string()
      .regex(/^[A-Z]{2}$|^$/)
      .default(""),
    style: z.string().trim().min(1).max(500),
    bio: z.string().max(4000).default(""),
    system_prompt: z.string().max(8000).default(""),
  })
  .strict();
export const ExampleInput = z
  .object({
    tweet_text: z.string().min(1).max(5000),
    reply_text: z.string().min(1).max(2000),
  })
  .strict();
export const SourceInput = z
  .object({
    type: z.enum(["search", "list"]),
    value: z.string().trim().min(1).max(500),
    priority: z.number().int().min(1).max(10).default(5),
  })
  .strict()
  .refine(
    (v) => v.type !== "list" || /^\d{1,25}$/.test(v.value),
    "list ID must be numeric",
  );
export const AccountInput = z
  .object({
    access_token: z.string().min(10).max(4096),
    refresh_token: z.string().max(4096).optional(),
    proxy_string: z.string().max(2000).optional(),
    timezone: z.string().max(100).default("Europe/Moscow"),
    browser_profile: z.literal("official-api").default("official-api"),
  })
  .strict();
export interface Tweet {
  id: string;
  text: string;
  author_id: string;
  username: string;
  created_at: string;
  likes: number;
  retweets: number;
  followers: number;
  is_reply: boolean;
  is_retweet: boolean;
  is_quote: boolean;
  images: string[];
}
export interface Account {
  id: string;
  user_id: string;
  x_user_id: string;
  x_username: string;
  credentials_encrypted: string;
  proxy_encrypted: string | null;
  timezone: string;
  status: string;
  proxy_status: string;
  proxy_country: string | null;
  cooldown_until: string | null;
}
export interface Campaign {
  id: string;
  user_id: string;
  account_id: string;
  lore_id: string;
  status: string;
  settings_json: z.infer<typeof Settings>;
  filters_json: z.infer<typeof Filters>;
}
export interface Lore {
  id: string;
  name: string;
  style: string;
  bio: string;
  system_prompt: string;
}
export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
export function filterTweet(
  tweet: Tweet,
  filters: z.infer<typeof Filters>,
  blacklist: Array<{ type: string; value: string }>,
  now = Date.now(),
): string | null {
  const age = (now - Date.parse(tweet.created_at)) / 60000;
  if (!Number.isFinite(age) || age < filters.min_age || age > filters.max_age)
    return "age";
  if (filters.skip_replies && tweet.is_reply) return "reply";
  if (filters.skip_retweets && tweet.is_retweet) return "retweet";
  if (filters.skip_quotes && tweet.is_quote) return "quote";
  if (
    tweet.likes < filters.min_likes ||
    tweet.retweets < filters.min_retweets ||
    tweet.followers < filters.min_followers
  )
    return "metrics";
  const text = tweet.text.toLocaleLowerCase();
  for (const item of blacklist) {
    if (item.type === "word" && text.includes(item.value.toLocaleLowerCase()))
      return "word";
    if (
      item.type === "account" &&
      tweet.username.toLowerCase() ===
        item.value.replace(/^@/, "").toLowerCase()
    )
      return "account";
  }
  return null;
}
export function sleeping(
  settings: z.infer<typeof Settings>,
  timezone: string,
  now = new Date(),
): boolean {
  if (!settings.sleep_enabled || settings.sleep_start === settings.sleep_end)
    return false;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  return settings.sleep_start < settings.sleep_end
    ? hour >= settings.sleep_start && hour < settings.sleep_end
    : hour >= settings.sleep_start || hour < settings.sleep_end;
}
