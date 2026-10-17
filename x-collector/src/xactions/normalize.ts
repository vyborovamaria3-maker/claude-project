import type { AccountProfileData, RawTweet } from "../../lib/trade/twitter-scraper";

type Count = number | null | undefined;
type HttpAuthor = { id?: string | null; restId?: string | null; username?: string | null; name?: string | null; verified?: boolean | null };
type HttpMedia = { type?: string | null; url?: string | null; videoUrl?: string | null };
type HttpUrl = { url?: string | null; expandedUrl?: string | null };
type HttpMention = { username?: string | null };

export interface XActionsHttpTweet {
  id?: string | null;
  text?: string | null;
  createdAt?: string | null;
  author?: HttpAuthor | null;
  metrics?: { views?: Count; likes?: Count; retweets?: Count; replies?: Count } | null;
  urls?: HttpUrl[] | null;
  hashtags?: string[] | null;
  mentions?: HttpMention[] | null;
  media?: HttpMedia[] | null;
  quotedTweet?: { id?: string | null } | null;
  inReplyTo?: { tweetId?: string | null } | null;
}

export type VerificationEvidence = "verified" | "unverified" | "unknown";
export type XActionsNormalizedProfile = AccountProfileData & { verificationEvidence: VerificationEvidence };

/** Explicit GraphQL verification field is stronger than an upstream parser's
 * default false. Absence must remain unknown, not a negative observation. */
export function explicitVerificationEvidence(raw: unknown): VerificationEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const value = raw as Record<string, unknown>;
  const verification = value.verification;
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    const confirmed = (verification as Record<string, unknown>).verified;
    if (typeof confirmed === "boolean") return confirmed ? "verified" : "unverified";
  }
  return "unknown";
}

export interface XActionsHttpProfile {
  username?: string | null;
  name?: string | null;
  bio?: string | null;
  followers?: Count;
  following?: Count;
  followersCount?: Count;
  followingCount?: Count;
  tweets?: Count;
  verified?: boolean | null;
  joined?: string | null;
  avatar?: string | null;
}

/**
 * XActions 3.5.0 replaces absent engagement metrics with zero.
 * Zero therefore cannot be distinguished from "not provided". Preserve known
 * positive values and leave non-positive/absent values as null, rather than
 * creating misleading historical observations.
 */
function uncertainCount(value: Count): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function handle(value: string | null | undefined): string {
  const clean = (value ?? "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(clean)) throw new Error("XActions: invalid author handle");
  return clean;
}

export function normalizeXActionsTweet(input: XActionsHttpTweet, observedAt = Date.now()): RawTweet {
  const id = input.id ?? "";
  if (!/^\d{15,25}$/.test(id)) throw new Error("XActions: invalid post ID");
  if (typeof input.text !== "string") throw new Error("XActions: missing post text");
  const authorHandle = handle(input.author?.username);
  const authorIdValue = input.author?.id ?? input.author?.restId;
  const authorId = typeof authorIdValue === "string" && /^\\d{1,25}$/.test(authorIdValue) ? authorIdValue : null;
  const urls = (input.urls ?? []).map(item => validHttpUrl(item.expandedUrl ?? item.url)).filter((s): s is string => Boolean(s));
  const mentions = (input.mentions ?? []).map(item => (item.username ?? "").replace(/^@/, ""))
    .filter(name => /^[A-Za-z0-9_]{1,15}$/.test(name));
  const media: RawTweet["media"] = (input.media ?? []).flatMap(item => {
    const url = validHttpUrl(item.type === "video" || item.type === "animated_gif" ? (item.videoUrl ?? item.url) : item.url);
    if (!url) return [];
    return [{ type: item.type === "video" || item.type === "animated_gif" ? "video" as const : "photo" as const, url }];
  });
  const relatedPostIds = [input.quotedTweet?.id, input.inReplyTo?.tweetId]
    .filter((value): value is string => typeof value === "string" && /^\d+$/.test(value));
  return {
    id, text: input.text, authorHandle, authorId,
    authorDisplayName: input.author?.name ?? null,
    url: `https://x.com/${authorHandle}/status/${id}`,
    views: uncertainCount(input.metrics?.views),
    likes: uncertainCount(input.metrics?.likes),
    retweets: uncertainCount(input.metrics?.retweets),
    replies: uncertainCount(input.metrics?.replies),
    isVerified: input.author?.verified === true,
    postedAt: timestamp(input.createdAt),
    observedAt,
    links: [...new Set(urls)], hashtags: [...new Set(input.hashtags ?? [])],
    mentions: [...new Set(mentions)], media,
    relatedPostIds: [...new Set(relatedPostIds)],
  };
}

export function normalizeXActionsProfile(input: XActionsHttpProfile, evidence: VerificationEvidence = "unknown"): XActionsNormalizedProfile {
  const username = handle(input.username);
  return {
    handle: username,
    displayName: input.name ?? null,
    bio: input.bio ?? null,
    followers: uncertainCount(input.followers ?? input.followersCount),
    following: uncertainCount(input.following ?? input.followingCount),
    postsCount: uncertainCount(input.tweets),
    isVerified: input.verified === true,
    verificationEvidence: input.verified === true ? "verified" : evidence,
    joinedAt: timestamp(input.joined),
    avatarUrl: validHttpUrl(input.avatar),
  };
}
