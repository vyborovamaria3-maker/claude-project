import { NextResponse } from "next/server";
import { verifyBotToken, getBotCommands } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const { action, token } = await request.json();

    if (action === "verify") {
      if (!token) {
        return NextResponse.json({ error: "Token required" }, { status: 400 });
      }
      const result = await verifyBotToken(token);
      if (!result.valid) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      const commands = await getBotCommands(token);
      return NextResponse.json({ bot: result.botInfo, commands });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const error = err as { message?: string };
    return NextResponse.json({ error: error.message || "Internal error" }, { status: 500 });
  }
}
