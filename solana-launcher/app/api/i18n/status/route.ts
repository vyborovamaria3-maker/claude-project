import { NextResponse } from "next/server";

export async function GET() {
  const ok = Boolean(process.env.LINGODOTDEV_API_KEY);

  return NextResponse.json(
    {
      ok,
      provider: "lingo.dev",
      fallbackLocale: "en",
      reason: ok ? null : "Missing LINGODOTDEV_API_KEY",
    },
    { status: 200 },
  );
}
