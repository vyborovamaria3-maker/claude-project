import { NextResponse } from "next/server";
import { getChatInfo } from "@/lib/telegram";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    features: {
      botVerification: true,
      channelVerification: true,
      inviteLinks: true,
      stealthDelays: true,
      batchProcessing: true,
    },
  });
}

export async function POST(request: Request) {
  try {
    const { token, targetChatId, sourceChatIds, settings } = await request.json();

    if (!token || !targetChatId || !Array.isArray(sourceChatIds) || !sourceChatIds.length) {
      return NextResponse.json(
        { error: "Token, targetChatId, and sourceChatIds (non-empty array) required" },
        { status: 400 }
      );
    }

    // Verify target channel
    const targetResult = await getChatInfo(token, targetChatId);
    if (!targetResult.success) {
      return NextResponse.json(
        { error: `Target channel error: ${targetResult.error}` },
        { status: 400 }
      );
    }

    // Verify source channels
    const sourceResults = await Promise.allSettled(
      sourceChatIds.map((id: string) => getChatInfo(token, id))
    );

    const validSources = sourceResults
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getChatInfo>>> =>
          r.status === "fulfilled" && r.value.success
      )
      .map((r) => r.value.chat!);

    const failedSources = sourceResults.reduce<{ id: string; error: string }[]>((acc, r, i) => {
      if (r.status === "rejected") {
        acc.push({ id: sourceChatIds[i], error: r.reason?.message || "Failed" });
      } else if (r.status === "fulfilled" && !r.value.success) {
        acc.push({ id: sourceChatIds[i], error: r.value.error || "Verification failed" });
      }
      return acc;
    }, []);

    // Build import plan
    const plan = {
      target: targetResult.chat,
      sources: validSources,
      failedSources,
      totalMembers: validSources.reduce((acc, s) => acc + (s.memberCount || 0), 0),
      settings: {
        delay: settings?.delay || 100,
        batchSize: settings?.batchSize || 10,
        batchPause: settings?.batchPause || 60,
        stealthMode: settings?.stealthMode ?? true,
        maxPerDay: settings?.maxPerDay || 100,
      },
      estimatedTime: calculateEstimatedTime(
        validSources.reduce((acc, s) => acc + (s.memberCount || 0), 0),
        settings?.delay || 100,
        settings?.batchSize || 10,
        settings?.batchPause || 60
      ),
    };

    return NextResponse.json({ plan });
  } catch (err: unknown) {
    const error = err as { message?: string };
    return NextResponse.json({ error: error.message || "Internal error" }, { status: 500 });
  }
}

function calculateEstimatedTime(
  totalMembers: number,
  delayMs: number,
  batchSize: number,
  batchPauseSec: number
): string {
  if (totalMembers === 0) return "0 members";

  const batches = Math.ceil(totalMembers / batchSize);
  const inviteTime = batches * delayMs;
  const pauseTime = batches * batchPauseSec * 1000;
  const totalMs = inviteTime + pauseTime;

  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);

  if (hours > 0) return `~${hours}h ${minutes}m`;
  if (minutes > 0) return `~${minutes}m`;
  const seconds = Math.floor((totalMs % 60000) / 1000);
  return `~${seconds}s`;
}
