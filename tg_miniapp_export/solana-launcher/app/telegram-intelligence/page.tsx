"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Crosshair, Loader2, Network, Play, Radio, RefreshCw, Search, Square, Users } from "lucide-react";

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL || "/fastapi").replace(/\/$/, "");

type ChannelRow = {
  id: number;
  username: string | null;
  title: string;
  entity_type: string;
  participants: number;
  score: number;
  calls_count: number;
  win_rate: number;
  rug_rate: number;
  avg_roi: number;
};

type CallRow = {
  id: number;
  mint_address: string;
  channel: string;
  caller_username: string | null;
  called_at: string;
  explicit_call: boolean;
  roi_multiple: number | null;
  outcome: string;
};

type CallerRow = {
  username: string;
  calls: number;
  wins: number;
  win_rate: number;
  rug_rate: number;
  avg_roi: number;
  score: number;
};

type Timeline = {
  mint_address: string;
  mentions: number;
  platforms: Record<string, number>;
  origin: Record<string, unknown> | null;
  timeline: Array<{
    rank: number;
    platform: string;
    source_handle: string | null;
    source_name: string | null;
    source_url: string | null;
    text: string;
    occurred_at: string;
    metrics: Record<string, unknown> | null;
  }>;
};

function authHeaders(json = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("potapoff.access_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BACKEND}${path}`, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
  return payload as T;
}

export default function TelegramIntelligencePage() {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [callers, setCallers] = useState<CallerRow[]>([]);
  const [sessionStatus, setSessionStatus] = useState<Record<string, unknown> | null>(null);
  const [seedText, setSeedText] = useState("");
  const [mint, setMint] = useState("");
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seeds = useMemo(
    () => seedText.split(/[\n,\s]+/).map((item) => item.trim().replace(/^@/, "")).filter(Boolean),
    [seedText],
  );

  const loadOverview = useCallback(async () => {
    setError(null);
    try {
      const [session, channelData, callData, callerData] = await Promise.all([
        api<Record<string, unknown>>("/api/v1/telegram/session/status", { headers: authHeaders() }),
        api<{ items: ChannelRow[] }>("/api/v1/telegram/channels?limit=100"),
        api<{ items: CallRow[] }>("/api/v1/telegram/calls?limit=100"),
        api<{ items: CallerRow[] }>("/api/v1/telegram/top-callers?limit=50"),
      ]);
      setSessionStatus(session);
      setChannels(channelData.items || []);
      setCalls(callData.items || []);
      setCallers(callerData.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  async function scan() {
    if (!seeds.length) return;
    setBusy("scan");
    setError(null);
    try {
      await api("/api/v1/telegram/scan", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ seeds, max_depth: 2, post_limit: 300, entity_limit: 100 }),
      });
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function startMonitor() {
    if (!seeds.length) return;
    setBusy("monitor");
    setError(null);
    try {
      await api("/api/v1/telegram/monitor/start", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ channels: seeds }),
      });
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function stopMonitor() {
    setBusy("stop");
    setError(null);
    try {
      await api("/api/v1/telegram/monitor/stop", { method: "POST", headers: authHeaders() });
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function evaluate() {
    setBusy("evaluate");
    setError(null);
    try {
      await api("/api/v1/telegram/calls/evaluate?limit=5000", { method: "POST", headers: authHeaders() });
      await loadOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function lookupToken(refreshX = false) {
    const clean = mint.trim();
    if (!clean) return;
    setBusy(refreshX ? "x" : "token");
    setError(null);
    try {
      if (refreshX) {
        await api(`/api/v1/social/x/refresh/${encodeURIComponent(clean)}`, {
          method: "POST",
          headers: authHeaders(),
        });
      }
      setTimeline(await api<Timeline>(`/api/v1/social/token/${encodeURIComponent(clean)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-[1500px] space-y-6 px-4 py-6 md:px-6">
      <section className="surface-panel-hero rounded-3xl border border-white/10 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
              <Radio className="h-3.5 w-3.5" /> Telegram + X Social Intelligence
            </div>
            <h1 className="mt-3 text-3xl font-black text-white">Мемкоин-разведка Telegram</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/50">
              История каналов и групп, Solana CA, callers, ROI, realtime monitoring и единая хронология Telegram/X.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-white/60">
            Session: <span className="font-semibold text-white">{sessionStatus?.session_configured ? "configured" : "not configured"}</span>
            {sessionStatus?.running ? <span className="ml-3 text-emerald-300">● monitoring</span> : null}
          </div>
        </div>
      </section>

      {error ? <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div> : null}

      <section className="grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
        <div className="surface-panel rounded-2xl border border-white/10 p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold text-white"><Search className="h-4 w-4" /> Сканирование и monitor</h2>
          <textarea
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            rows={4}
            placeholder="pumpfun_calls\nsolana_alpha\nhttps://t.me/example"
            className="mt-4 w-full rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white outline-none placeholder:text-white/25"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={scan} disabled={!seeds.length || busy !== null} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-bold text-black disabled:opacity-40">
              {busy === "scan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Scan graph
            </button>
            <button onClick={startMonitor} disabled={!seeds.length || busy !== null} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
              <Radio className="h-4 w-4" /> Monitor
            </button>
            <button onClick={stopMonitor} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
              <Square className="h-4 w-4" /> Stop
            </button>
            <button onClick={evaluate} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
              <Activity className="h-4 w-4" /> Evaluate ROI
            </button>
          </div>
        </div>

        <div className="surface-panel rounded-2xl border border-white/10 p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold text-white"><Crosshair className="h-4 w-4" /> Token timeline</h2>
          <div className="mt-4 flex gap-2">
            <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Solana mint / CA" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none" />
            <button onClick={() => lookupToken(false)} disabled={!mint.trim() || busy !== null} className="rounded-xl border border-white/15 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Find</button>
            <button onClick={() => lookupToken(true)} disabled={!mint.trim() || busy !== null} className="inline-flex items-center gap-1 rounded-xl border border-white/15 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"><RefreshCw className="h-4 w-4" /> X</button>
          </div>
          {timeline ? (
            <div className="mt-4 space-y-2">
              <div className="text-xs text-white/50">Mentions: {timeline.mentions} · TG {timeline.platforms.telegram || 0} · X {timeline.platforms.x || 0}</div>
              <div className="max-h-72 space-y-2 overflow-auto pr-1">
                {timeline.timeline.map((item) => (
                  <div key={`${item.platform}-${item.rank}`} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between gap-2 text-xs text-white/45"><span>{item.platform.toUpperCase()} · {item.source_handle || item.source_name || "unknown"}</span><span>{new Date(item.occurred_at).toLocaleString()}</span></div>
                    <p className="mt-2 line-clamp-3 text-sm text-white/75">{item.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Panel title="Каналы" icon={<Network className="h-4 w-4" />}>
          {channels.slice(0, 12).map((row) => (
            <Row key={row.id} title={row.username ? `@${row.username}` : row.title} subtitle={`${row.calls_count} calls · WR ${(row.win_rate * 100).toFixed(0)}% · rug ${(row.rug_rate * 100).toFixed(0)}%`} value={row.score.toFixed(1)} />
          ))}
        </Panel>
        <Panel title="Последние calls" icon={<Activity className="h-4 w-4" />}>
          {calls.slice(0, 12).map((row) => (
            <Row key={row.id} title={row.channel} subtitle={`${row.mint_address.slice(0, 7)}… · ${row.outcome}`} value={row.roi_multiple ? `${row.roi_multiple.toFixed(1)}x` : "—"} />
          ))}
        </Panel>
        <Panel title="Top callers" icon={<Users className="h-4 w-4" />}>
          {callers.slice(0, 12).map((row) => (
            <Row key={row.username} title={`@${row.username}`} subtitle={`${row.calls} calls · WR ${(row.win_rate * 100).toFixed(0)}% · avg ${row.avg_roi.toFixed(1)}x`} value={row.score.toFixed(1)} />
          ))}
        </Panel>
      </section>
    </main>
  );
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <div className="surface-panel rounded-2xl border border-white/10 p-5"><h3 className="flex items-center gap-2 text-sm font-bold text-white">{icon}{title}</h3><div className="mt-4 space-y-2">{children}</div></div>;
}

function Row({ title, subtitle, value }: { title: string; subtitle: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"><div className="min-w-0"><div className="truncate text-sm font-semibold text-white">{title}</div><div className="truncate text-xs text-white/40">{subtitle}</div></div><div className="shrink-0 text-sm font-black text-white">{value}</div></div>;
}
