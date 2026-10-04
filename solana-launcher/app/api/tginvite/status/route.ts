import { NextResponse } from "next/server";

export async function GET() {
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
