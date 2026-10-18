/** Strictly normalize a target chat before creating an opt-in Telegram link. */
export function normalizeTGInviteDestination(value: string): string | null {
  const input = value.trim();
  if (/^-?[0-9]{1,20}$/.test(input)) {
    return Number.isSafeInteger(Number(input)) ? input : null;
  }

  const username = input.match(/^@?([A-Za-z][A-Za-z0-9_]{4,31})$/);
  if (username) return `@${username[1]}`;

  const publicUrl = input.match(/^https:\/\/(?:www\.)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i);
  return publicUrl ? `@${publicUrl[1]}` : null;
}

/** Never present an arbitrary response as a Telegram-issued invite link. */
export function confirmedTGInviteLink(response: unknown): string | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const payload = response as Record<string, unknown>;
  if (payload.status !== "created" || !payload.link || typeof payload.link !== "object") return null;
  const link = payload.link as Record<string, unknown>;
  // The Telegram Bot API must explicitly confirm join-request approval.
  // A plausible-looking URL alone does not prove that approval is required.
  if (link.createsJoinRequest !== true) return null;
  const inviteLink = link.inviteLink;
  if (typeof inviteLink !== "string") return null;
  return /^https:\/\/t\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+$/.test(inviteLink) ? inviteLink : null;
}
