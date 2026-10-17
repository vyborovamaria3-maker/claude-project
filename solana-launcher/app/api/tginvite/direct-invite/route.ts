/** One authenticated, consent-gated MTProto invitation per HTTP request. */
import { getBackendBaseUrl } from "@/lib/authProxy";
import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { resolveTGInviteClient } from "@/lib/tginvite-vault-client";
import { inviteOneConsentingUser } from "@/lib/tginvite-mtproto";
import { normalizeTGInviteDestination } from "@/lib/tginvite-optin";
import { NextResponse } from "next/server";

const CHAT = /^-100[1-9][0-9]{4,16}$/;
const USER = /^[1-9][0-9]{0,15}$/;
const KEY = /^[A-Za-z0-9_-]{16,96}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const auth = await requireTGInviteUser(request);
  if (auth.error) return auth.error;
  const serviceKey = process.env.TG_INVITE_INTERNAL_KEY;
  if (!serviceKey || serviceKey.length < 32) {
    return NextResponse.json({ error: "Direct invite service not configured" }, { status: 503 });
  }
  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid direct invite request" }, { status: 422 });
  }
  const data = raw as Record<string, unknown>;
  const destinationChatId = data.destinationChatId;
  const recipientId = data.recipientId;
  const idempotencyKey = data.idempotencyKey;
  const targetChannel = typeof data.targetChannel === "string"
    ? normalizeTGInviteDestination(data.targetChannel) : null;
  const sourceChannel = data.sourceChannel === undefined || data.sourceChannel === ""
    ? undefined : typeof data.sourceChannel === "string"
      ? normalizeTGInviteDestination(data.sourceChannel) : null;

  if (typeof destinationChatId !== "string" || !CHAT.test(destinationChatId) ||
      typeof recipientId !== "string" || !USER.test(recipientId) ||
      !Number.isSafeInteger(Number(recipientId)) ||
      typeof idempotencyKey !== "string" || !KEY.test(idempotencyKey) ||
      !targetChannel || sourceChannel === null) {
    return NextResponse.json({ error: "Invalid chat, user or source channel" }, { status: 422 });
  }

  const headers = {
    Authorization: auth.authorization!,
    "X-TGInvite-Service-Key": serviceKey,
    "Content-Type": "application/json",
  };
  let client: Record<string, unknown> | null;
  try {
    client = await resolveTGInviteClient(auth.ownerId!, auth.authorization!);
  } catch {
    return NextResponse.json({ error: "Telegram account unavailable" }, { status: 503 });
  }
  if (!client) return NextResponse.json({ error: "Connect your Telegram user account first" }, { status: 409 });

  // Only the backend may verify bot-authenticated, chat-scoped recipient opt-in.
  // Claim is an atomic durable one-time reservation across workers.
  let jobId: string;
  try {
    const claimed = await fetch(`${getBackendBaseUrl()}/api/v1/tginvite/direct-invite/claim`, {
      method: "POST", headers, cache: "no-store", redirect: "error",
      body: JSON.stringify({
        destination_chat_id: destinationChatId,
        recipient_telegram_id: recipientId,
        idempotency_key: idempotencyKey,
      }),
    });
    if (!claimed.ok) {
      const status = [403, 409, 429].includes(claimed.status) ? claimed.status : 503;
      return NextResponse.json(
        { error: status === 409 ? "No fresh verified /join request, or invitation already reserved" :
            status === 429 ? "Direct invitation rate limit reached" :
            status === 403 ? "Chat is not authorized for this account" : "Direct invite ledger unavailable" },
        { status, headers: claimed.headers.get("Retry-After")
          ? { "Retry-After": claimed.headers.get("Retry-After")! } : undefined },
      );
    }
    const result: unknown = await claimed.json();
    const row = result && typeof result === "object" ? result as Record<string, unknown> : {};
    if (row.status !== "reserved" || typeof row.jobId !== "string" || !UUID.test(row.jobId)) {
      return NextResponse.json({ error: "Direct invite reservation result unavailable" }, { status: 503 });
    }
    jobId = row.jobId;
  } catch {
    // A reservation may have happened even if its response was lost. Never
    // retry automatically: an idempotency key fences any manual repetition.
    return NextResponse.json({ error: "Unable to verify invitation reservation" }, { status: 503 });
  }

  let outcome: "invited" | "declined" | "unknown" = "unknown";
  try {
    outcome = await inviteOneConsentingUser(client, {
      destinationChatId, recipientId: Number(recipientId), targetChannel,
      sourceChannel: sourceChannel || undefined,
    });
  } catch {
    outcome = "unknown";
  }

  try {
    const finished = await fetch(
      `${getBackendBaseUrl()}/api/v1/tginvite/direct-invite/${jobId}/finish`,
      {
        method: "POST", headers, cache: "no-store", redirect: "error",
        body: JSON.stringify({ outcome }),
      },
    );
    if (!finished.ok) throw new Error("Outcome ledger refused result");
    const result: unknown = await finished.json();
    if (!result || typeof result !== "object" ||
        (result as Record<string, unknown>).status !== outcome) {
      throw new Error("Outcome was not confirmed by ledger");
    }
  } catch {
    // The saved state may still be 'reserved'. Never assert that Telegram
    // accepted an invitation unless the durable server ledger confirms it.
    return NextResponse.json(
      { jobId, status: "unknown", error: "Telegram result not confirmed by audit ledger" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  return NextResponse.json(
    { jobId, status: outcome },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
