import { NextResponse } from "next/server";
import { requireTGInviteUser } from "@/lib/tginvite-auth";

export async function GET(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  return NextResponse.json(
    { ownerId: user.ownerId },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
