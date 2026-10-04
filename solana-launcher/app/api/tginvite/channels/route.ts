import { NextResponse } from "next/server";
import { getChatInfo } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const { action, token, chatId, chatIds } = await request.json();

    if (action === "verify") {
      if (!token || !chatId) {
        return NextResponse.json({ error: "Token and chatId required" }, { status: 400 });
      }
      const result = await getChatInfo(token, chatId);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ chat: result.chat });
    }

    if (action === "verifyMultiple") {
      if (!token || !Array.isArray(chatIds) || !chatIds.length) {
        return NextResponse.json({ error: "Token and chatIds (non-empty array) required" }, { status: 400 });
      }
      const results = await Promise.allSettled(
        chatIds.map((id: string) => getChatInfo(token, id))
      );
      const chats = results
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getChatInfo>>> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((r) => r.success);
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason?.message || "Failed");
      return NextResponse.json({ chats: chats.map((c) => c.chat), errors });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const error = err as { message?: string };
    return NextResponse.json({ error: error.message || "Internal error" }, { status: 500 });
  }
}
