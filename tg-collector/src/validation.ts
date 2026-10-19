export function normalizePublicUsername(input: string): string {
  const value = input.trim()
    .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .toLowerCase();
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(value) || /^(joinchat|addlist|share|proxy|login|boost)$/i.test(value)) {
    throw new Error("Only public Telegram @usernames (5-32 characters) are supported.");
  }
  return value;
}

export function telegramWaitSeconds(error: unknown): number | null {
  const typed = error as { seconds?: unknown; message?: unknown } | null;
  const seconds = typed && typeof typed.seconds === "number" ? typed.seconds : undefined;
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const matched = String(typed?.message ?? error).match(/FLOOD_WAIT_?(\d+)/i);
  if (!matched) return null;
  const parsed = Number(matched[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}


export function publicDiscoveryChannel(input: unknown): {peer: string; username: string; title: string} | null {
 const c = input as {className?: string; username?: string;usernames?:{username:string;active?:boolean}[]; title?: string; id?: {toString(): string}; broadcast?: boolean; megagroup?: boolean; forbidden?: boolean} | null;
 const username=c?.username??c?.usernames?.find(u=>u.active)?.username;
 if (!c || c.className !== "Channel" || (!c.broadcast && !c.megagroup) || c.forbidden ||
     !username || !/^[a-z][a-z0-9_]{4,31}$/i.test(username)) return null;
 const peer=c.id?.toString(); if (!peer || !/^[1-9][0-9]{0,18}$/.test(peer)) return null;
 return {peer,username:username.toLowerCase(),title:(c.title || username).slice(0,255)};
}
