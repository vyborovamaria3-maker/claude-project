import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    channels: [],
    stats: { total: 0, imported: 0, pending: 0, failed: 0 },
    jobs: [],
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, channels, filters } = body;

    if (action === "analyze") {
      return NextResponse.json({
        status: "analyzed",
        channels: channels?.map((ch: string) => ({
          username: ch,
          members: Math.floor(Math.random() * 10000),
          activity: Math.random(),
          quality: Math.random(),
        })),
      });
    }

    if (action === "import") {
      return NextResponse.json({
        status: "started",
        jobId: Date.now().toString(),
        target: body.target,
        sources: channels,
        filters,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}
