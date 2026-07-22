import { NextResponse } from "next/server";
import { getDatabaseDashboardData } from "@/lib/databaseDashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getDatabaseDashboardData(), {
      headers: {
        "Cache-Control": "public, max-age=10, stale-while-revalidate=30",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load database dashboard" },
      { status: 500 },
    );
  }
}
