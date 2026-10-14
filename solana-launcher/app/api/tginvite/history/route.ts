import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  return NextResponse.json({
    history: [],
    source: "no_persistent_history",
  });
}
