import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  isSupportedLocale,
  normalizeLocale,
  resolveSupportedLocale,
} from "@/lib/i18n/locales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_TEXT_CHARS = 10_000;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  ar: "Arabic",
  he: "Hebrew",
  ja: "Japanese",
  ko: "Korean",
  zh: "Simplified Chinese",
};

type CacheValue = {
  text: string;
  sourceLocale: string;
  targetLocale: string;
  ts: number;
};

const CACHE = new Map<string, CacheValue>();

function safeSourceLocale(value: unknown) {
  const normalized = normalizeLocale(
    typeof value === "string" ? value : "en",
  );

  return /^[a-z]{2,3}$/.test(normalized)
    ? normalized
    : "en";
}

function cacheKey(text: string, sourceLocale: string, targetLocale: string) {
  return createHash("sha256")
    .update(`${sourceLocale}\0${targetLocale}\0${text}`, "utf8")
    .digest("hex");
}

function trimCache() {
  const now = Date.now();

  for (const [key, value] of CACHE) {
    if (now - value.ts > CACHE_TTL_MS) {
      CACHE.delete(key);
    }
  }

  while (CACHE.size > MAX_CACHE_ENTRIES) {
    const first = CACHE.keys().next().value as string | undefined;
    if (!first) break;
    CACHE.delete(first);
  }
}

async function translateViaLingo(
  text: string,
  sourceLocale: string,
  targetLocale: string,
) {
  const apiKey =
    process.env.LINGODOTDEV_API_KEY
    || process.env.LINGO_API_KEY
    || "";

  if (!apiKey) return null;

  const engineId =
    process.env.LINGODOTDEV_ENGINE_ID
    || process.env.LINGO_ENGINE_ID
    || "";

  const upstreamBody: Record<string, unknown> = {
    sourceLocale,
    targetLocale,
    data: { text },
    context:
      "POTAPOFF X/Twitter evidence display. Preserve token tickers, "
      + "@handles, Solana contract addresses, URLs, emoji, hashtags, "
      + "cashtags and crypto terminology exactly.",
  };

  if (engineId) {
    upstreamBody.engineId = engineId;
  }

  try {
    const response = await fetch(
      "https://api.lingo.dev/process/localize",
      {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(upstreamBody),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) return null;

    const payload = await response.json().catch(() => null) as
      | { data?: { text?: unknown } }
      | null;

    const translated = payload?.data?.text;

    return typeof translated === "string" && translated.trim()
      ? translated.trim()
      : null;
  } catch {
    return null;
  }
}

function cleanAiTranslation(value: unknown) {
  if (typeof value !== "string") return null;

  let text = value.trim();

  if (!text) return null;

  text = text
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const quoted = text.match(/^["“](.*)["”]$/s);
  if (quoted?.[1]) {
    text = quoted[1].trim();
  }

  return text || null;
}

async function translateViaExistingAi(
  text: string,
  sourceLocale: string,
  targetLocale: string,
) {
  const aiBase = (
    process.env.MEMECOIN_INTELLIGENCE_URL
    || "http://host.docker.internal:3001"
  ).replace(/\/$/, "");

  const apiKey =
    process.env.MEMECOIN_INTELLIGENCE_API_KEY
    || process.env.INTERNAL_API_KEY
    || "";

  const sourceLanguage =
    LANGUAGE_NAMES[sourceLocale]
    || sourceLocale;

  const targetLanguage =
    LANGUAGE_NAMES[targetLocale]
    || targetLocale;

  const prompt = [
    "TRANSLATION TASK ONLY.",
    `Translate the text below from ${sourceLanguage} to ${targetLanguage}.`,
    "Return ONLY the translated text in the summary field.",
    "Do not analyze, explain, summarize, prepend labels, or use markdown.",
    "Preserve token tickers, @handles, Solana contract addresses, URLs,",
    "emoji, hashtags, cashtags, numbers and crypto terminology exactly.",
    "",
    "SOURCE_TEXT:",
    text,
  ].join("\n");

  const now = new Date().toISOString();

  const payload = {
    messages: [{
      id: `potapoff-i18n-${Date.now()}`,
      channelId: "i18n",
      channelUsername: "potapoff_i18n",
      channelTitle: "POTAPOFF i18n",
      senderId: "system",
      text: prompt,
      sentAt: now,
      editedAt: null,
      views: 0,
      forwards: 0,
      reactions: 0,
      replyToMessageId: null,
      links: [],
    }],
    context: {
      analysisMode: "telegram_only",
      analysisRole: "analyst",
    },
    persist: false,
  };

  try {
    const response = await fetch(
      `${aiBase}/api/telegram-ai/analyze`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey
            ? {
                "x-api-key": apiKey,
                authorization: `Bearer ${apiKey}`,
              }
            : {}),
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) return null;

    const body = await response.json().catch(() => null) as
      | {
          result?: { summary?: unknown };
          summary?: unknown;
        }
      | null;

    return cleanAiTranslation(
      body?.result?.summary
      ?? body?.summary
      ?? null,
    );
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;

  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "invalid_json" },
      { status: 400 },
    );
  }

  const text = typeof body.text === "string"
    ? body.text
    : "";

  if (!text.trim()) {
    return NextResponse.json(
      { error: "text_required" },
      { status: 400 },
    );
  }

  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      { error: "text_too_long" },
      { status: 413 },
    );
  }

  const requestedTarget = typeof body.targetLocale === "string"
    ? body.targetLocale
    : "";

  if (!isSupportedLocale(requestedTarget)) {
    return NextResponse.json(
      { error: "unsupported_target_locale" },
      { status: 400 },
    );
  }

  const sourceLocale = safeSourceLocale(body.sourceLocale);
  const targetLocale = resolveSupportedLocale(requestedTarget);

  if (sourceLocale === targetLocale) {
    return NextResponse.json({
      text,
      sourceLocale,
      targetLocale,
      cached: true,
      translated: false,
      provider: "original",
    });
  }

  trimCache();

  const key = cacheKey(text, sourceLocale, targetLocale);
  const cached = CACHE.get(key);

  if (cached && Date.now() - cached.ts <= CACHE_TTL_MS) {
    return NextResponse.json({
      text: cached.text,
      sourceLocale: cached.sourceLocale,
      targetLocale: cached.targetLocale,
      cached: true,
      translated: true,
      provider: "cache",
    });
  }

  const lingoTranslation = await translateViaLingo(
    text,
    sourceLocale,
    targetLocale,
  );

  const translated = lingoTranslation
    || await translateViaExistingAi(
      text,
      sourceLocale,
      targetLocale,
    );

  if (!translated) {
    return NextResponse.json(
      { error: "translation_provider_unavailable" },
      { status: 503 },
    );
  }

  CACHE.set(key, {
    text: translated,
    sourceLocale,
    targetLocale,
    ts: Date.now(),
  });

  trimCache();

  return NextResponse.json({
    text: translated,
    sourceLocale,
    targetLocale,
    cached: false,
    translated: true,
    provider: lingoTranslation ? "lingo.dev" : "existing-ai",
  });
}
