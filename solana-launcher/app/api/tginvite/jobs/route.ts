/** Server-only proxy for the non-dispatching TGInvite audit ledger. */
import { getBackendBaseUrl } from "@/lib/authProxy";
import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { NextResponse } from "next/server";

const ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

function backendHeaders(authorization: string): Record<string, string> | null {
  const secret = process.env.TG_INVITE_INTERNAL_KEY;
  if (!secret || secret.length < 32) return null;
  return { Authorization: authorization, "X-TGInvite-Service-Key": secret };
}

export async function GET(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  const headers = backendHeaders(user.authorization);
  if (!headers) return NextResponse.json({ error: "Job ledger unavailable" }, { status: 503 });
  const limitRaw = new URL(request.url).searchParams.get("limit");
  const limit = limitRaw == null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "limit must be between 1 and 100" }, { status: 422 });
  }
  try {
    const response = await fetch(
      `${getBackendBaseUrl()}/api/v1/tginvite/invite-jobs?limit=${limit}`,
      { method: "GET", headers, cache: "no-store" },
    );
    if (!response.ok) {
      return NextResponse.json({ error: "Job ledger unavailable" }, { status: 503 });
    }
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error("Invalid ledger response");
    // Only return explicitly approved, non-sensitive audit properties.
    const jobs = data.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Invalid ledger job");
      const row = item as Record<string, unknown>;
      if (
        typeof row.id !== "string" || !ID_PATTERN.test(row.id) ||
        typeof row.destination_chat_id !== "string" ||
        typeof row.created_at !== "string" ||
        (row.status !== "blocked_transport" && row.status !== "cancelled")
      ) throw new Error("Invalid ledger job");
      return {
        id: row.id, destination_chat_id: row.destination_chat_id,
        status: row.status, created_at: row.created_at,
      };
    });
    return NextResponse.json(jobs, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Job ledger unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  const headers = backendHeaders(user.authorization);
  if (!headers) return NextResponse.json({ error: "Job ledger unavailable" }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid audit action" }, { status: 422 });
  }
  const data = body as Record<string, unknown>;
  if (data.action !== "cancel" || typeof data.jobId !== "string" || !ID_PATTERN.test(data.jobId)) {
    return NextResponse.json({ error: "Only job cancellation is supported" }, { status: 422 });
  }
  try {
    const response = await fetch(
      `${getBackendBaseUrl()}/api/v1/tginvite/invite-jobs/${data.jobId}/cancel`,
      { method: "POST", headers, cache: "no-store" },
    );
    if (response.status === 404) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (response.status !== 204) {
      return NextResponse.json({ error: "Job ledger unavailable" }, { status: 503 });
    }
    return NextResponse.json(
      { status: "cancelled" }, { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Job ledger unavailable" }, { status: 503 });
  }
}
