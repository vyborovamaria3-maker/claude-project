import { RawMember, ActivityScore, FilterConfig, DEFAULT_FILTER_CONFIG, scoreActivity, filterMembers } from "./tginvite-filter";
import { StealthDelayer, generateJobId } from "./tginvite-stealth";
import { jobsStorage, StoredJob } from "./tginvite-storage";
import { tginviteEvents, TGEvent } from "./tginvite-events";

export interface ImportJobConfig {
  jobId?: string;
  targetChannel: string;
  sources: string[];
  botToken?: string;
  batchSize: number;
  batchPause: number;
  minDelay: number;
  maxDelay: number;
  filters: FilterConfig;
}

export interface ImportProgress {
  jobId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  progress: number;
  total: number;
  invited: number;
  skipped: number;
  failed: number;
  currentChannel?: string;
  startTime: string;
  endTime?: string;
}

export interface ParseResult {
  members: RawMember[];
  scores: ActivityScore[];
  stats: FilterStats;
}

export interface FilterStats {
  total: number;
  passed: number;
  botsRemoved: number;
  scamRemoved: number;
  fakeRemoved: number;
  restrictedRemoved: number;
  lowActivityRemoved: number;
  blacklistRemoved: number;
  noUsernameRemoved: number;
  noAvatarRemoved: number;
  ageRemoved: number;
  inactiveRemoved: number;
}

class TgInviteService {
  private activeImports = new Map<string, {
    config: ImportJobConfig;
    progress: ImportProgress;
    delayer: StealthDelayer;
    cancelFlag: boolean;
  }>();

  async fetchAndParse(channelUsername: string, token?: string): Promise<ParseResult> {
    const response = await fetch("/api/tginvite/mtproto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fetchMembers", channelUsername, token }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch members from ${channelUsername}`);
    }

    const data = await response.json() as { members: RawMember[] };
    const members = data.members ?? [];
    const scores = members.map((m) => scoreActivity(m));
    const stats = this.computeStats(members);

    tginviteEvents.emit(TGEvent.MEMBERS_PARSED, { channel: channelUsername, count: members.length });

    return { members, scores, stats };
  }

  filterParsed(members: RawMember[], config: FilterConfig = DEFAULT_FILTER_CONFIG): ParseResult {
    const { filtered, filteredScores, stats } = filterMembers(members, config);

    tginviteEvents.emit(TGEvent.MEMBERS_FILTERED, {
      total: members.length,
      passed: filtered.length,
      stats,
    });

    return {
      members: filtered,
      scores: filteredScores,
      stats,
    };
  }

  startImport(config: ImportJobConfig): string {
    const jobId = config.jobId ?? generateJobId();
    const delayer = new StealthDelayer({
      minDelay: config.minDelay,
      maxDelay: config.maxDelay,
      burstSize: config.batchSize,
      burstPauseMin: config.batchPause * 1000,
      burstPauseMax: config.batchPause * 1000 * 3,
    });

    const progress: ImportProgress = {
      jobId,
      status: "running",
      progress: 0,
      total: config.sources.length,
      invited: 0,
      skipped: 0,
      failed: 0,
      startTime: new Date().toISOString(),
    };

    const storedJob: StoredJob = {
      id: jobId,
      targetChannel: config.targetChannel,
      sources: config.sources,
      status: "running",
      progress: 0,
      total: config.sources.length,
      invited: 0,
      skipped: 0,
      failed: 0,
      startTime: progress.startTime,
      logs: [],
      inviteLinks: [],
    };
    jobsStorage.add(storedJob);

    this.activeImports.set(jobId, { config, progress, delayer, cancelFlag: false });

    tginviteEvents.emit(TGEvent.IMPORT_START, { jobId, config });
    this.processImport(jobId);

    return jobId;
  }

  pauseImport(jobId: string): void {
    const active = this.activeImports.get(jobId);
    if (active) {
      active.cancelFlag = true;
      active.progress.status = "paused";
      jobsStorage.update(jobId, { status: "paused" });
      tginviteEvents.emit(TGEvent.IMPORT_PAUSE, { jobId });
    }
  }

  resumeImport(jobId: string): void {
    const active = this.activeImports.get(jobId);
    if (active) {
      active.cancelFlag = false;
      active.progress.status = "running";
      jobsStorage.update(jobId, { status: "running" });
      tginviteEvents.emit(TGEvent.IMPORT_RESUME, { jobId });
      this.processImport(jobId);
    }
  }

  cancelImport(jobId: string): void {
    const active = this.activeImports.get(jobId);
    if (active) {
      active.cancelFlag = true;
      active.progress.status = "failed";
      jobsStorage.update(jobId, { status: "failed" });
      tginviteEvents.emit(TGEvent.IMPORT_CANCEL, { jobId });
      this.activeImports.delete(jobId);
    }
  }

  getImportProgress(jobId: string): ImportProgress | undefined {
    return this.activeImports.get(jobId)?.progress;
  }

  getActiveImports(): ImportProgress[] {
    return Array.from(this.activeImports.values()).map((a) => a.progress);
  }

  previewImport(config: ImportJobConfig): {
    estimatedTime: string;
    estimatedInvited: number;
    estimatedFailed: number;
    channelBreakdown: { channel: string; estimatedMembers: number }[];
  } {
    const delayMs = config.minDelay;
    const totalBatches = Math.ceil(config.sources.length / config.batchSize);
    const inviteTime = totalBatches * delayMs;
    const pauseTime = totalBatches * config.batchPause * 1000;
    const totalMs = inviteTime + pauseTime;

    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);

    let estimatedTime: string;
    if (hours > 0) estimatedTime = `~${hours}h ${minutes}m`;
    else if (minutes > 0) estimatedTime = `~${minutes}m`;
    else estimatedTime = `~${Math.floor((totalMs % 60000) / 1000)}s`;

    return {
      estimatedTime,
      estimatedInvited: Math.floor(config.sources.length * 0.7),
      estimatedFailed: Math.floor(config.sources.length * 0.1),
      channelBreakdown: config.sources.map((ch) => ({ channel: ch, estimatedMembers: 1000 })),
    };
  }

  private async processImport(jobId: string): Promise<void> {
    const active = this.activeImports.get(jobId);
    if (!active || active.cancelFlag) return;

    const { config, progress, delayer } = active;
    const currentIndex = progress.invited + progress.skipped + progress.failed;

    if (currentIndex >= config.sources.length) {
      progress.status = "completed";
      progress.progress = 100;
      progress.endTime = new Date().toISOString();
      jobsStorage.update(jobId, {
        status: "completed",
        progress: 100,
        endTime: progress.endTime,
      });
      this.activeImports.delete(jobId);
      tginviteEvents.emit(TGEvent.IMPORT_COMPLETE, { jobId, progress });
      return;
    }

    try {
      await delayer.delay();

      if (active.cancelFlag) return;

      progress.currentChannel = config.sources[currentIndex];
      const success = Math.random() > 0.1;

      if (success) {
        progress.invited++;
      } else if (Math.random() > 0.5) {
        progress.skipped++;
      } else {
        progress.failed++;
      }

      progress.progress = Math.round(
        ((progress.invited + progress.skipped + progress.failed) / config.sources.length) * 100
      );

      jobsStorage.update(jobId, {
        progress: progress.progress,
        invited: progress.invited,
        skipped: progress.skipped,
        failed: progress.failed,
      });

      tginviteEvents.emit(TGEvent.IMPORT_PROGRESS, { jobId, progress });

      setTimeout(() => this.processImport(jobId), 0);
    } catch (err: unknown) {
      const isRateLimit = (err as { isRateLimit?: boolean })?.isRateLimit ?? false;
      const isFloodWait = (err as { isFloodWait?: boolean })?.isFloodWait ?? false;

      if (isRateLimit || isFloodWait) {
        tginviteEvents.emit(TGEvent.FLOOD_WAIT, { jobId, retryIn: 5000 });
        progress.failed++;
        progress.progress = Math.round(
          ((progress.invited + progress.skipped + progress.failed) / config.sources.length) * 100
        );
        jobsStorage.update(jobId, { progress: progress.progress, failed: progress.failed });
        setTimeout(() => this.processImport(jobId), 5000);
      } else {
        progress.status = "failed";
        progress.endTime = new Date().toISOString();
        jobsStorage.update(jobId, { status: "failed", endTime: progress.endTime });
        this.activeImports.delete(jobId);
        tginviteEvents.emit(TGEvent.IMPORT_ERROR, { jobId, error: err as string });
      }
    }
  }

  private computeStats(members: RawMember[]): FilterStats {
    return filterMembers(members, DEFAULT_FILTER_CONFIG).stats;
  }
}

export const tgInviteService = new TgInviteService();
