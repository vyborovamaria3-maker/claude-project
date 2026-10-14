/** Validation shared by live link creation and side-effect-free dry runs. */
export interface InviteLinkRequest {
  token: string;
  chatId: string;
  name: string;
  expireDate?: number;
  memberLimit?: number;
  count: number;
  createsJoinRequest: boolean;
}

export class InvalidInviteRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInviteRequest";
  }
}
function optionalPositiveInteger(value: unknown, name: string, max: number): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new InvalidInviteRequest(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/** Refuse malformed jobs instead of silently clamping recipient counts. */
export function validateInviteLinkRequest(
  raw: unknown,
  mode: "createLink" | "batchLinks",
  nowMs: number = Date.now(),
): InviteLinkRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidInviteRequest("Invalid link request");
  }
  const body = raw as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 256) throw new InvalidInviteRequest("Bot token required");
  const chatId = typeof body.chatId === "string" ? body.chatId.trim() :
    typeof body.chatId === "number" && Number.isSafeInteger(body.chatId) ? String(body.chatId) : "";
  if (!/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?[0-9]{1,20})$/.test(chatId)) {
    throw new InvalidInviteRequest("Valid chat ID or public @username required");
  }
  const name = body.linkName == null ? "TGInvite" :
    typeof body.linkName === "string" ? body.linkName.trim() : "";
  if (name.length > 32) throw new InvalidInviteRequest("Link name must be at most 32 characters");
  if (body.createsJoinRequest != null && typeof body.createsJoinRequest !== "boolean") {
    throw new InvalidInviteRequest("createsJoinRequest must be a boolean");
  }
  const createsJoinRequest = body.createsJoinRequest === true;
  const days = optionalPositiveInteger(body.expireDays, "expireDays", 365);
  const memberLimit = optionalPositiveInteger(body.memberLimit, "memberLimit", 99999);
  if (createsJoinRequest && memberLimit != null) {
    throw new InvalidInviteRequest("Join-request links cannot specify memberLimit");
  }
  const count = mode === "batchLinks" ?
    optionalPositiveInteger(body.linkCount, "linkCount", 10) ?? 1 : 1;
  const expireDate = days == null ? undefined : Math.floor(nowMs / 1000) + days * 86400;
  return { token, chatId, name, expireDate, memberLimit, count, createsJoinRequest };
}

export function batchInviteLinkName(base: string, sequence: number): string {
  const suffix = ` #${sequence}`;
  return `${base.slice(0, 32 - suffix.length)}${suffix}`;
}

/** No network requests: safely account for missing invitees on a mocked API response. */
export interface InviteResultAccounting {
  invited: number;
  declined: number;
  unknown: number;
  declinedUserIds: string[];
}
export function reconcileInviteToChannelResult(
  requestedIds: readonly (number | string | bigint)[],
  response: unknown,
): InviteResultAccounting {
  const failClosed = (): InviteResultAccounting => ({
    invited: 0, declined: 0, unknown: requestedIds.length, declinedUserIds: [],
  });
  if (!response || typeof response !== "object" || Array.isArray(response)) return failClosed();
  const result = response as Record<string, unknown>;
  // GramJS camelCase field, or MTProto snake_case serialized output.
  const missing = result.missingInvitees ?? result.missing_invitees;
  if (!Array.isArray(missing)) return failClosed();
  const expected = new Set(requestedIds.map(String));
  if (expected.size !== requestedIds.length) return failClosed();
  const failures = new Set<string>();
  for (const raw of missing) {
    if (!raw || typeof raw !== "object") return failClosed();
    const item = raw as Record<string, unknown>;
    const id = item.userId ?? item.user_id;
    if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") {
      return failClosed();
    }
    const asString = String(id);
    if (!expected.has(asString) || failures.has(asString)) return failClosed();
    failures.add(asString);
  }
  return {
    invited: requestedIds.length - failures.size,
    declined: failures.size,
    unknown: 0,
    declinedUserIds: [...failures],
  };
}
