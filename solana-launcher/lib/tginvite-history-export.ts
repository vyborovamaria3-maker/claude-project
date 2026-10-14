/** Safe local export of the owner's already retrieved, bounded public history preview. */
export interface AuthorizedHistoryMessage {
  message_id: number;
  text: string;
  published_at: string | null;
  views: number;
  forwards: number;
}

const CSV_FIELDS = ["message_id", "published_at", "text", "views", "forwards"] as const;

function spreadsheetSafe(value: string): string {
  // Prevent CSV formula execution, including formula prefixes hidden after spaces.
  return /^\s*[=+@-]/.test(value) ? "'" + value : value;
}

function csvCell(value: string | number | null): string {
  const rendered = spreadsheetSafe(value === null ? "" : String(value));
  return `"${rendered.replaceAll('"', '""')}"`;
}

export function buildHistoryCsv(messages: AuthorizedHistoryMessage[]): string {
  const header = CSV_FIELDS.join(",");
  const lines = messages.map((message) => CSV_FIELDS.map((field) => csvCell(message[field])).join(","));
  return "\uFEFF" + [header, ...lines].join("\r\n") + "\r\n";
}

export function buildHistoryJson(source: string, messages: AuthorizedHistoryMessage[]): string {
  return JSON.stringify({
    source,
    coverage: "recent_accessible_messages",
    complete_history: false,
    exported_at: new Date().toISOString(),
    count: messages.length,
    messages,
  }, null, 2);
}
