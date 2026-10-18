/** Serialize cross-database timestamps explicitly in UTC. Never accept a naive local timestamp. */
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function toUtcIso(value: Date | string): string {
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new TypeError("Timestamp must be an ISO string with offset or Date");
  }
  if (typeof value === "string" && !OFFSET_TIMESTAMP.test(value)) {
    throw new TypeError("Timestamp requires a timezone offset");
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid timestamp");
  return date.toISOString();
}
