import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  return NextResponse.json({
    channels: [],
    stats: { total: 0, imported: 0, pending: 0, failed: 0 },
    jobs: [],
  });
}

export async function POST(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  try {
    const body = await request.json();
    const { action, channels, filters } = body;

    if (action === "analyze") {
      return NextResponse.json({ error: "Use the authenticated MTProto analysis API" }, { status: 501 });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}
