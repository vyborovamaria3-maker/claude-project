const PREFIX = "tginvite_";
const UUID_RE = /^[0-9a-f-]{36}$/i;
let activeOwnerId: string | null = null;

/**
 * Browser storage must never be accessible until the authenticated backend
 * identifies the current owner. Legacy unscoped keys are intentionally ignored:
 * automatically assigning them to the next logged-in user would leak data.
 */
export function bindTGInviteStorageOwner(ownerId: string | null): void {
  if (ownerId !== null && !UUID_RE.test(ownerId)) {
    throw new Error("Invalid TGInvite storage identity");
  }
  activeOwnerId = ownerId?.toLowerCase() ?? null;
}

function scopedKey(key: string): string | null {
  return activeOwnerId ? `${PREFIX}${activeOwnerId}_${key}` : null;
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    const scoped = scopedKey(key);
    if (!scoped) return fallback;
    try {
      const raw = localStorage.getItem(scoped);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },

  set<T>(key: string, value: T): void {
    if (typeof window === "undefined") return;
    const scoped = scopedKey(key);
    if (!scoped) return;
    try {
      localStorage.setItem(scoped, JSON.stringify(value));
    } catch {}
  },

  remove(key: string): void {
    if (typeof window === "undefined") return;
    const scoped = scopedKey(key);
    if (!scoped) return;
    localStorage.removeItem(scoped);
  },

  clear(): void {
    if (typeof window === "undefined") return;
    const scoped = scopedKey("");
    if (!scoped) return;
    Object.keys(localStorage)
      .filter((k) => k.startsWith(scoped))
      .forEach((k) => localStorage.removeItem(k));
  },
};

export interface StoredChannel {
  id: string;
  name: string;
  username: string;
  members: number;
  type?: string;
  verified?: boolean;
  addedAt?: string;
  selected?: boolean;
  group?: string;
  activity?: number;
  quality?: number;
  lastImport?: string;
  status?: "active" | "inactive" | "banned";
  inviteLink?: string;
}

export interface StoredJob {
  id: string;
  targetChannel: string;
  sources: string[];
  status: "pending" | "running" | "paused" | "completed" | "failed";
  progress: number;
  total: number;
  invited: number;
  skipped: number;
  failed: number;
  startTime: string;
  endTime?: string;
  logs: string[];
  inviteLinks: { url: string; used: boolean; username?: string }[];
}

export interface StoredSettings {
  botToken: string;
  targetChannel: string;
  delay: number;
  batchSize: number;
  batchPause: number;
  stealthMode: boolean;
  maxPerDay: number;
  minDelay: number;
  maxDelay: number;
  mtprotoSession?: string;
  scheduleEnabled?: boolean;
  scheduleInterval?: string;
  scheduleTimezone?: string;
  scheduleStartTime?: string;
  scheduleEndTime?: string;
  scheduleCustomCron?: string;
  filterMinActivity?: number;
  filterMaxAge?: number;
  filterMinQuality?: number;
  filterLimit?: number;
  filterMinFollowers?: number;
  filterMaxFollowers?: number;
  filterVerifiedOnly?: boolean;
  filterHasAvatar?: boolean;
  filterBlacklist?: string[];
  filterWhitelist?: string[];
}

export const channelsStorage = {
  getAll: () => storage.get<StoredChannel[]>("channels", []),
  set: (channels: StoredChannel[]) => storage.set("channels", channels),
  add: (ch: StoredChannel) => {
    const all = channelsStorage.getAll();
    if (!all.some((c) => c.id === ch.id)) {
      all.push(ch);
      channelsStorage.set(all);
    }
  },
  remove: (id: string) => {
    channelsStorage.set(channelsStorage.getAll().filter((c) => c.id !== id));
  },
};

export const jobsStorage = {
  getAll: () => storage.get<StoredJob[]>("jobs", []),
  set: (jobs: StoredJob[]) => storage.set("jobs", jobs),
  add: (job: StoredJob) => {
    const all = jobsStorage.getAll();
    all.push(job);
    jobsStorage.set(all);
  },
  update: (id: string, updates: Partial<StoredJob>) => {
    const all = jobsStorage.getAll();
    const idx = all.findIndex((j) => j.id === id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], ...updates };
      jobsStorage.set(all);
    }
  },
};

export const settingsStorage = {
  get: () => {
    const loaded = storage.get<StoredSettings>("settings", {
      botToken: "",
      targetChannel: "",
      delay: 100,
      batchSize: 10,
      batchPause: 60,
      stealthMode: true,
      maxPerDay: 100,
      minDelay: 50,
      maxDelay: 300,
    });
    // Migrate legacy browser storage: active sessions and bot tokens must not persist.
    if (loaded.botToken || loaded.mtprotoSession) {
      const sanitized = { ...loaded, botToken: "", mtprotoSession: undefined };
      storage.set("settings", sanitized);
      return sanitized;
    }
    return loaded;
  },
  set: (settings: StoredSettings) =>
    storage.set("settings", { ...settings, botToken: "", mtprotoSession: undefined }),
};
