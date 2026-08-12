"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BrainCircuit, Gauge, Network, Search, ShieldAlert, TrendingUp } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { siteDesign } from "@/lib/siteDesign";
import { MINT_RE } from "@/lib/trade/social-intelligence";

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL || "/fastapi").replace(/\/$/, "");

type Investigation = {
  mint: string;
  snapshots: Array<{
    snapshot_id: string;
    created_at: string;
    confidence: number | null;
    feature_count: number;
    graph_version: string;
  }>;
  campaign_fingerprints: Array<{
    snapshot_id: string;
    hash: string;
    vector: Record<string, number>;
    actors: string[] | null;
    narratives: unknown[] | null;
  }>;
  hypotheses: Array<{
    key: string;
    type: string;
    source: string | null;
    target: string | null;
    status: string;
    confidence: number;
    support_count: number;
    contradiction_count: number;
    updated_at: string;
  }>;
  outcomes: Array<{
    snapshot_id: string;
    horizon_hours: number;
    label: string;
    max_multiple: number | null;
    max_drawdown_pct: number | null;
  }>;
};

function pct(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export default function AdvancedInvestigationPanel() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("mint")?.trim() || "";
  const [query, setQuery] = useState(initial);
  const [data, setData] = useState<Investigation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (mint: string) => {
    if (!MINT_RE.test(mint)) {
      setError("Введи корректный Solana mint / CA.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${BACKEND}/api/v1/social/intelligence/advanced/investigation/${encodeURIComponent(mint)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload.detail || payload.error || `HTTP ${response.status}`));
      }
      setData(payload as Investigation);
      router.replace(
        `/trade/analysis/investigation?mint=${encodeURIComponent(mint)}`,
        { scroll: false },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Investigation API недоступен");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (MINT_RE.test(initial)) void load(initial);
    // URL mint is intentionally loaded once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const latest = data?.snapshots[0] || null;
  const latestFingerprint = useMemo(() => {
    if (!data || !latest) return null;
    return data.campaign_fingerprints.find(
      (item) => item.snapshot_id === latest.snapshot_id,
    ) || null;
  }, [data, latest]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load(query.trim());
  };

  return (
    <div className="space-y-5" data-tag="trade.advanced_investigation.v1">
      <header>
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-content">Advanced Intelligence Investigation</h1>
        </div>
        <p className="mt-1 text-xs text-content-muted">
          История snapshots, campaign fingerprints, lifecycle гипотез и outcomes без изменения production score.
        </p>
      </header>

      <form onSubmit={submit} className="surface-panel rounded-2xl border border-bg-border p-4">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
              placeholder="Solana mint / CA"
            />
          </div>
          <button
            disabled={loading}
            className={siteDesign.controls.primaryActionClassName}
          >
            {loading ? "Загрузка…" : "Открыть"}
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          {error}
        </div>
      )}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Snapshots" value={String(data.snapshots.length)} icon={<Network />} />
            <Stat label="Hypotheses" value={String(data.hypotheses.length)} icon={<BrainCircuit />} />
            <Stat label="Outcomes" value={String(data.outcomes.length)} icon={<TrendingUp />} />
            <Stat label="Latest confidence" value={pct(latest?.confidence ?? null)} icon={<Gauge />} />
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="Latest campaign fingerprint">
              {latestFingerprint ? (
                <div className="space-y-3">
                  <div className="font-mono text-[10px] text-content-faint">
                    {latestFingerprint.hash}
                  </div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {Object.entries(latestFingerprint.vector).map(([key, value]) => (
                      <div key={key} className="rounded-lg border border-bg-border bg-bg-card p-2">
                        <div className="text-[9px] uppercase text-content-faint">{key}</div>
                        <div className="mt-1 font-mono text-xs font-semibold text-content">{value.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-content-muted">
                    Actors: {(latestFingerprint.actors || []).join(" · ") || "—"}
                  </div>
                </div>
              ) : (
                <Empty text="Fingerprint ещё не накоплен." />
              )}
            </Panel>

            <Panel title="Hypothesis lifecycle">
              <div className="space-y-2">
                {data.hypotheses.length ? data.hypotheses.map((item) => (
                  <div key={item.key} className="rounded-xl border border-bg-border bg-bg-card p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold text-content">{item.type}</div>
                      <span className="rounded-full border border-bg-border px-2 py-1 text-[9px] uppercase text-content-muted">
                        {item.status}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-content-faint">
                      {item.source || "?"} → {item.target || "?"}
                    </div>
                    <div className="mt-2 text-[10px] text-content-muted">
                      Confidence {pct(item.confidence)} · support {item.support_count} · contradictions {item.contradiction_count}
                    </div>
                  </div>
                )) : <Empty text="Исторических гипотез пока нет." />}
              </div>
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="Snapshot history">
              <div className="space-y-2">
                {data.snapshots.map((item) => (
                  <div key={item.snapshot_id} className="grid grid-cols-[1fr_auto] gap-3 rounded-xl border border-bg-border bg-bg-card p-3 text-[10px]">
                    <div>
                      <div className="font-mono text-content">{item.snapshot_id}</div>
                      <div className="mt-1 text-content-faint">{new Date(item.created_at).toLocaleString()} · {item.graph_version}</div>
                    </div>
                    <div className="text-right text-content-muted">
                      {item.feature_count} features<br />{pct(item.confidence)}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Outcome learning">
              <div className="space-y-2">
                {data.outcomes.length ? data.outcomes.map((item) => (
                  <div key={`${item.snapshot_id}-${item.horizon_hours}`} className="rounded-xl border border-bg-border bg-bg-card p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-content">{item.horizon_hours}h · {item.label}</span>
                      <ShieldAlert className="h-4 w-4 text-content-faint" />
                    </div>
                    <div className="mt-2 text-[10px] text-content-muted">
                      Max {item.max_multiple == null ? "—" : `${item.max_multiple.toFixed(2)}x`} · DD {item.max_drawdown_pct == null ? "—" : `${item.max_drawdown_pct.toFixed(1)}%`}
                    </div>
                  </div>
                )) : <Empty text="Outcomes появятся после созревания 6h/24h/72h окон." />}
              </div>
            </Panel>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="surface-panel rounded-xl border border-bg-border p-3">
      <div className="flex items-center justify-between text-content-faint">
        <span className="text-[9px] uppercase tracking-wider">{label}</span>
        <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      </div>
      <div className="mt-2 font-mono text-lg font-bold text-content">{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="surface-panel rounded-2xl border border-bg-border p-4">
      <h2 className="mb-3 text-sm font-semibold text-content">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-content-faint">{text}</div>;
}
