import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
const id = z.string().regex(/^\d{1,25}$/);
const date = z.string().refine(v => Number.isFinite(Date.parse(v)), "invalid timestamp");
const metric = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional();
const entities=z.object({mentions:z.array(z.object({id:id.optional(),username:z.string().optional()})).optional()}).passthrough();
export const Post = z.object({ id, text: z.string(), created_at: date, metrics_observed_at: date.optional(), author_id: id.optional(), author_handle: z.string().optional(), conversation_id: id.optional(), lang: z.string().optional(),
    public_metrics: z.object({ like_count: metric, impression_count: metric, retweet_count: metric, repost_count: metric, reply_count: metric, quote_count: metric }).passthrough().optional(),
    referenced_tweets: z.array(z.object({ id, type: z.string() })).optional(), referenced_posts: z.array(z.object({ id, type: z.string() })).optional(),
    entities: entities.optional(),
    note_tweet: z.object({ text: z.string(),entities:entities.optional() }).passthrough().optional(), note_post: z.object({ text: z.string(),entities:entities.optional() }).passthrough().optional(),
}).passthrough();
export const Page = z.object({ data: z.array(Post).default([]), includes: z.object({ users: z.array(z.object({ id, username: z.string().optional() }).passthrough()).optional(), tweets: z.array(Post).optional(), posts: z.array(Post).optional() }).passthrough().optional(),
    meta: z.object({ next_token: z.string().optional() }).passthrough().optional(), errors: z.array(z.unknown()).optional() }).passthrough();
export type ArchivePage = z.infer<typeof Page>;
export function validMint(value: string): boolean {
    try {
        return new PublicKey(value).toBase58() === value;
    }
    catch {
        return false;
    }
}
export function addresses(text: string): string[] {
    return [...new Set((text.match(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g) ?? []).filter(validMint))];
}
export function windows(start: string, end: string, days = 1): Array<{
    start: string;
    end: string;
}> {
    const a = Date.parse(start), b = Date.parse(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || !Number.isInteger(days) || days < 1 || days > 31)
        throw new Error("invalid archive range");
    if ((b - a) / 86400000 > 3660)
        throw new Error("archive range exceeds ten years");
    const out = [];
    for (let t = a; t < b; t += days * 86400000)
        out.push({ start: new Date(t).toISOString(), end: new Date(Math.min(b, t + days * 86400000)).toISOString() });
    return out;
}
