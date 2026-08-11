import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// memecoin-intelligence is deployed as a separate compose stack and publishes API :3001.
// The frontend container reaches the host through host.docker.internal (see docker-compose.yml).
const AI_BASE = (process.env.MEMECOIN_INTELLIGENCE_URL || "http://host.docker.internal:3001").replace(/\/$/, "");
const API_KEY = process.env.MEMECOIN_INTELLIGENCE_API_KEY || process.env.INTERNAL_API_KEY || "";

type TimelineItem = {
  source_handle?: string | null;
  source_name?: string | null;
  text?: string;
  occurred_at?: string;
  metrics?: Record<string, unknown> | null;
};

type RequestBody = {
  mint?: string;
  symbol?: string;
  tokenName?: string;
  timeline?: TimelineItem[];
};

function n(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function stableId(item: TimelineItem, index: number) {
  return `social-${createHash("sha1")
    .update(`${item.source_handle || item.source_name || "unknown"}|${item.occurred_at || ""}|${item.text || ""}|${index}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const mint = String(body.mint || "").trim();
  const timeline = Array.isArray(body.timeline) ? body.timeline : [];
  if (!mint || timeline.length === 0) {
    return NextResponse.json({ error: "mint_and_telegram_timeline_required" }, { status: 400 });
  }

  const messages = timeline.slice(0, 120).map((item, index) => {
    const metrics = item.metrics || {};
    const channel = String(item.source_handle || item.source_name || "unknown");
    const sentAt = item.occurred_at && Number.isFinite(Date.parse(item.occurred_at))
      ? new Date(item.occurred_at).toISOString()
      : new Date().toISOString();
    return {
      id: stableId(item, index),
      channelId: channel.slice(0, 128),
      channelUsername: item.source_handle ? String(item.source_handle).replace(/^@/, "").slice(0, 128) : null,
      channelTitle: item.source_name ? String(item.source_name).slice(0, 256) : null,
      senderId: metrics.sender_id ? String(metrics.sender_id).slice(0, 128) : null,
      text: String(item.text || "").slice(0, 40_000),
      sentAt,
      editedAt: null,
      views: n(metrics.views),
      forwards: n(metrics.forwards),
      reactions: n(metrics.reactions),
      replyToMessageId: metrics.reply_to_message_id ? String(metrics.reply_to_message_id).slice(0, 128) : null,
      links: [],
    };
  }).filter((message) => message.text.trim().length > 0);

  if (!messages.length) {
    return NextResponse.json({ error: "no_telegram_text_for_ai" }, { status: 400 });
  }

  const windowTimes = messages.map((m) => Date.parse(m.sentAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const payload = {
    messages,
    context: {
      tokenAddress: mint,
      symbol: body.symbol ? String(body.symbol).replace(/^\$/, "").slice(0, 32) : null,
      tokenName: body.tokenName ? String(body.tokenName).slice(0, 128) : null,
      windowStart: windowTimes.length ? new Date(windowTimes[0]).toISOString() : null,
      windowEnd: windowTimes.length ? new Date(windowTimes[windowTimes.length - 1]).toISOString() : null,
    },
    persist: false,
  };

  try {
    const response = await fetch(`${AI_BASE}/api/telegram-ai/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY, authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json({
        error: result?.message || result?.error || result?.detail || `Qwen HTTP ${response.status}`,
        agent: "qwen",
        available: false,
      }, { status: response.status === 401 || response.status === 403 ? response.status : 502 });
    }
    return NextResponse.json({ agent: "qwen", available: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "qwen_unreachable",
      agent: "qwen",
      available: false,
    }, { status: 503 });
  }
}
