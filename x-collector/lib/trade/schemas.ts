import { z } from "zod";

export const SolanaMint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const Handle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);

export const SearchPayload = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(500).default(50),
  sort: z.enum(["top", "latest"]).default("latest"),
});

export const TimelinePayload = z.object({
  handle: Handle,
  limit: z.number().int().min(1).max(1000).default(300),
});

export const ProfilePayload = z.object({
  handle: Handle,
});

export const TweetSchema = z.object({
  id: z.string().regex(/^\d{15,25}$/),
  text: z.string().max(50_000),
  authorHandle: z.string().min(1).max(50),
  authorDisplayName: z.string().max(200).nullable(),
  url: z.union([z.string().url(), z.literal(""), z.null()]).transform((v) => v || null),
  views: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  retweets: z.number().int().nonnegative().nullable(),
  replies: z.number().int().nonnegative().nullable(),
  isVerified: z.boolean(),
  postedAt: z.number().int().min(0).max(8640000000000000).nullable(),
  observedAt: z.number().int().min(0).max(8640000000000000).optional(),
  links: z.array(z.string()).optional(),
  mentions: z.array(Handle).optional(),
  hashtags: z.array(z.string()).optional(),
  media: z.array(z.object({type:z.enum(["photo","video"]),url:z.string().url().nullable()})).optional(),
  relatedPostIds: z.array(z.string().regex(/^\d+$/)).optional(),
});

export const ProfileSchema = z.object({
  handle: Handle,
  displayName: z.string().max(200).nullable(),
  bio: z.string().max(2000).nullable(),
  followers: z.number().int().nonnegative().nullable(),
  following: z.number().int().nonnegative().nullable(),
  postsCount: z.number().int().nonnegative().nullable(),
  isVerified: z.boolean(),
  joinedAt: z.number().int().nullable(),
  avatarUrl: z.union([z.string().url(), z.null()]).transform((v) => v || null),
});

export function parseTaskPayload(kind: string, raw: unknown) {
  const json = typeof raw === "string" ? JSON.parse(raw) : raw;
  switch (kind) {
    case "search": return SearchPayload.parse(json);
    case "timeline": return TimelinePayload.parse(json);
    case "profile": return ProfilePayload.parse(json);
    default: throw new Error(`unknown kind: ${kind}`);
  }
}

