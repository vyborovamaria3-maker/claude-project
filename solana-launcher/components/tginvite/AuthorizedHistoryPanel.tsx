"use client";

import { useState } from "react";
import { Loader2, MessageSquareText } from "lucide-react";

interface HistoryMessage {
  message_id: number;
  text: string;
  published_at: string | null;
  views: number;
  forwards: number;
}
interface HistoryResponse {
  source: string;
  coverage: "recent_accessible_messages";
  complete_history: false;
  count: number;
  messages: HistoryMessage[];
}

export default function AuthorizedHistoryPanel({ username }: { username: string }) {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const valid = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username.trim());

  async function preview() {
    if (!valid) return;
    setLoading(true);
    setStatus("");
    setMessages([]);
    setSource("");
    try {
      const response = await fetch("/api/tginvite/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), limit: 50 }),
        cache: "no-store",
      });
      const data = await response.json() as HistoryResponse & { error?: string };
      if (!response.ok) {
        setStatus(data.error || "Unable to read channel history");
        return;
      }
      setSource(data.source);
      setMessages(data.messages || []);
      setStatus(data.count === 0 ? "No visible recent messages" : "");
    } catch {
      setStatus("The Telegram history service is unavailable");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-2xl border border-bg-border bg-bg-elevated p-5">
      <div className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
        <div>
          <h3 className="text-base font-semibold text-content">Authorized message preview</h3>
          <p className="mt-1 text-sm text-content-muted">
            Reads up to 50 recent messages using your connected Telegram account.
            Only public @usernames are supported; no automatic joining or bulk export.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-xl border border-bg-border px-4 py-2 text-sm text-content disabled:opacity-50"
          onClick={() => void preview()}
          disabled={!valid || loading}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
          {loading ? "Loading..." : "Preview 50"}
        </button>
      </div>
      {!valid && username.trim() && (
        <p className="mt-3 text-xs text-content-muted">Enter a public @channel username for the message preview.</p>
      )}
      {status && <p role="status" className="mt-3 text-sm text-content-muted">{status}</p>}
      {source && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-content-muted">
            @{source} · {messages.length} recent messages · results may be incomplete
          </p>
          {messages.map((row) => (
            <article key={row.message_id} className="rounded-lg border border-bg-border p-3">
              <p className="whitespace-pre-wrap break-words text-sm text-content">
                {row.text.slice(0, 500)}
              </p>
              <p className="mt-2 text-xs text-content-muted">
                ID {row.message_id} · {row.published_at || "Date unavailable"}
                {" · "}Views {row.views} · Forwards {row.forwards}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
