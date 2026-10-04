import { existsSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { fetchBackendSocial } from "@/lib/trade/backend-social-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function aiBase() {
  return (process.env.MEMECOIN_INTELLIGENCE_URL || "http://host.docker.internal:3001").replace(/\/$/, "");
}

async function readJson(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export async function GET(request: NextRequest) {
  const authPath = path.join(process.cwd(), "data", "x-auth", "storage-state.json");
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";

  let telegram: Record<string, unknown> = { available: false };
  try {
    const response = await fetchBackendSocial(request, "/api/v1/telegram/monitor/status");
    telegram = {
      available: response.ok,
      status: response.status,
      ...(await readJson(response)),
    };
  } catch (error) {
    telegram = { available: false, error: error instanceof Error ? error.message : "telegram_status_failed" };
  }

  let ai: Record<string, unknown> = { available: false };
  try {
    const key = process.env.MEMECOIN_INTELLIGENCE_API_KEY || process.env.INTERNAL_API_KEY || "";
    const response = await fetch(`${aiBase()}/api/telegram-ai/status`, {
      cache: "no-store",
      headers: key ? { "x-api-key": key, authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    ai = {
      available: response.ok,
      status: response.status,
      ...(await readJson(response)),
    };
  } catch (error) {
    ai = { available: false, error: error instanceof Error ? error.message : "ai_status_failed" };
  }

  return NextResponse.json(
    {
      ok: true,
      checkedAt: Date.now(),
      x: {
        authSessionPresent: existsSync(authPath),
        chromiumPresent: existsSync(chromiumPath),
        chromiumPath,
      },
      telegram,
      ai,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
