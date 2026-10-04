const PREFIX = "tginvite_";

export const storage = {
  get<T>(key: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },

  set<T>(key: string, value: T): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {}
  },

  remove(key: string): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(PREFIX + key);
  },

  clear(): void {
    if (typeof window === "undefined") return;
    Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
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
  get: () =>
    storage.get<StoredSettings>("settings", {
      botToken: "",
      targetChannel: "",
      delay: 100,
      batchSize: 10,
      batchPause: 60,
      stealthMode: true,
      maxPerDay: 100,
      minDelay: 50,
      maxDelay: 300,
    }),
  set: (settings: StoredSettings) => storage.set("settings", settings),
};
