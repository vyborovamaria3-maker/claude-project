/** Strict browser-side rendering contract for the owner-scoped TGInvite audit ledger. */
export interface TGInviteAuditJob {
  id: string;
  destination_chat_id: string;
  status: "blocked_transport" | "cancelled";
  created_at: string;
}

const ID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const CHAT_ID = /^-?[0-9]{1,20}$/;

export function parseTGInviteAuditJobs(raw: unknown): TGInviteAuditJob[] {
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error("Invalid TGInvite audit response");
  }
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid TGInvite audit row");
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !ID.test(row.id) ||
        typeof row.destination_chat_id !== "string" || !CHAT_ID.test(row.destination_chat_id) ||
        (row.status !== "blocked_transport" && row.status !== "cancelled") ||
        typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) {
      throw new Error("Invalid TGInvite audit row");
    }
    return {
      id: row.id,
      destination_chat_id: row.destination_chat_id,
      status: row.status,
      created_at: row.created_at,
    };
  });
}
