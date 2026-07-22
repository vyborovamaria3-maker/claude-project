import { NextResponse } from "next/server";
import { getApifySummary } from "@/lib/apify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getApifySummary());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load Apify summary" },
      { status: 500 },
    );
  }
}
