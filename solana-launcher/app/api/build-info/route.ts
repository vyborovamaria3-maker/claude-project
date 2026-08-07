import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      app: "potapoff",
      buildSha: process.env.NEXT_PUBLIC_BUILD_SHA || process.env.BUILD_SHA || "unknown",
      socialAnalysis: true,
      routes: {
        onchain: "/trade/analysis",
        social: "/trade/analysis/social",
      },
      generatedAt: new Date().toISOString(),
    },
    {
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}
