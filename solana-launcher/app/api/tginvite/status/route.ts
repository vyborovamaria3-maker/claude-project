import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  return NextResponse.json({
    status: "idle",
    progress: 0,
    invited: 0,
    skipped: 0,
    failed: 0,
    currentChannel: null,
    logs: [],
  });
}
