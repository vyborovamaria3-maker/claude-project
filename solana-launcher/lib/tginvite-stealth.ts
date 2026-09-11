export class StealthDelayer {
  private minDelay: number;
  private maxDelay: number;
  private burstSize: number;
  private burstPauseMin: number;
  private burstPauseMax: number;
  private consecutiveCalls: number = 0;
  private totalCalls: number = 0;

  constructor(options: {
    minDelay?: number;
    maxDelay?: number;
    burstSize?: number;
    burstPauseMin?: number;
    burstPauseMax?: number;
  } = {}) {
    this.minDelay = options.minDelay ?? 50;
    this.maxDelay = options.maxDelay ?? 300;
    this.burstSize = options.burstSize ?? 10;
    this.burstPauseMin = options.burstPauseMin ?? 5000;
    this.burstPauseMax = options.burstPauseMax ?? 20000;
  }

  async delay(): Promise<void> {
    this.consecutiveCalls++;
    this.totalCalls++;

    // Random micro-delay within range
    const ms = this.randomBetween(this.minDelay, this.maxDelay);
    await this.sleep(ms);

    // After burst_size consecutive calls, take a longer pause
    if (this.consecutiveCalls >= this.burstSize) {
      this.consecutiveCalls = 0;
      const pauseMs = this.randomBetween(this.burstPauseMin, this.burstPauseMax);
      await this.sleep(pauseMs);
    }
  }

  async onFloodWait(seconds: number): Promise<void> {
    this.consecutiveCalls = 0;
    const waitMs = Math.max(seconds * 1000, 30000);
    await this.sleep(waitMs);
  }

  getStats() {
    return {
      totalCalls: this.totalCalls,
      consecutiveCalls: this.consecutiveCalls,
      burstSize: this.burstSize,
    };
  }

  reset() {
    this.consecutiveCalls = 0;
    this.totalCalls = 0;
  }

  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function parseUsername(input: string): string | null {
  const cleaned = input.trim();
  // Direct username (min 3 chars — Telegram historical minimum)
  if (/^[a-zA-Z0-9_]{3,}$/.test(cleaned)) return cleaned;
  // @username
  const atMatch = cleaned.match(/@([a-zA-Z0-9_]{3,})/);
  if (atMatch) return atMatch[1];
  // t.me link (supports invite hashes too)
  const linkMatch = cleaned.match(/t\.me\/([a-zA-Z0-9_]{3,})/);
  if (linkMatch) return linkMatch[1];
  // Invite hash (t.me/+hash)
  const inviteMatch = cleaned.match(/t\.me\/\+([a-zA-Z0-9_-]+)/);
  if (inviteMatch) return `+${inviteMatch[1]}`;
  return null;
}

export function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
