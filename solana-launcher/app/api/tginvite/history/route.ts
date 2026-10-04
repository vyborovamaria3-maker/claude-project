import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    history: [
      {
        id: "1",
        targetChannel: "@example_channel",
        sources: ["@source1", "@source2"],
        status: "completed",
        invited: 150,
        skipped: 30,
        failed: 5,
        startTime: "2026-09-07T10:00:00Z",
        endTime: "2026-09-07T10:15:00Z",
      },
    ],
  });
}
