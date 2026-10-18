export type OutboxEvent = Readonly<{
  sourceSystem: "x" | "tg" | "blockchain" | "twitter_research";
  eventKind: string;
  eventKey: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
}>;

export type ClaimedEvent = OutboxEvent & Readonly<{
  id: string;
  attempts: number;
  leaseOwner: string;
  leaseUntil: string;
}>;

export function validateOutboxEvent(event: OutboxEvent): void {
  if (!["x","tg","blockchain","twitter_research"].includes(event.sourceSystem)) {
    throw new TypeError("Unsupported outbox source");
  }
  for (const [name, value] of Object.entries({
    eventKind: event.eventKind,
    eventKey: event.eventKey,
    schemaVersion: event.schemaVersion,
  })) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) {
      throw new TypeError("Invalid " + name);
    }
  }
  try {
    const serialized = JSON.stringify(event.payload);
    if (!serialized || serialized.length > 1_000_000 || Array.isArray(event.payload) ||
      typeof event.payload !== "object" || event.payload === null) {
      throw new TypeError("Payload must be a bounded JSON object");
    }
  } catch {
    throw new TypeError("Payload must be a bounded JSON object");
  }
}

export type ClaimOptions = Readonly<{
  workerId: string;
  batchSize: number;
  leaseMs: number;
  now?: Date;
}>;
export function checkClaimOptions(options: ClaimOptions): Date {
  if (!options.workerId?.trim() || options.workerId.length > 128 ||
    !Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1000 ||
    !Number.isInteger(options.leaseMs) || options.leaseMs < 1000 || options.leaseMs > 3_600_000) {
    throw new RangeError("Invalid outbox claim options");
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid now");
  return now;
}
