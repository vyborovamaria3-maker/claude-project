import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { NextResponse } from "next/server";
import { verifyBotToken, getBotCommands } from "@/lib/telegram";

export async function POST(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  try {
    const { action, token } = await request.json();

    if (action === "verify") {
      if (typeof token !== "string" || token.length === 0 || token.length > 256) {
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
  } catch {
    return NextResponse.json({ error: "Telegram bot verification service error" }, { status: 500 });
  }
}
