"use client";
// data-tag: components.trade.dev_forensics_panel

import { useEffect, useState, useCallback } from "react";
import {
  Twitter, AlertTriangle, CheckCircle, Clock, TrendingUp,
  BarChart2, Users, Bot, Loader2, RefreshCw, ChevronDown, ChevronUp, ExternalLink,
} from "lucide-react";
import type { TwitterStats } from "@/app/api/trade/dev-twitter/route";
import type { ForensicsResult, VolumeCorrelationBin } from "@/app/api/trade/dev-forensics/route";

interface Props {
  mint: string;
  symbol: string;
  devAddress: string;
}

// ── Mini Pie Chart (SVG, no deps) ────────────────────────────────────────────
function PieChart({ migrated, total }: { migrated: number; total: number }) {
  const notMigrated = total - migrated;
  if (total === 0) return <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center text-[10px] text-white/40">No data</div>;

  const r = 36;
  const cx = 40, cy = 40;
  const migratedAngle = (migrated / total) * 360;
  const rad = (deg: number) => (deg * Math.PI) / 180;

  function arc(startDeg: number, endDeg: number, color: string) {
    if (endDeg - startDeg >= 360) endDeg = 359.99;
    const x1 = cx + r * Math.cos(rad(startDeg - 90));
    const y1 = cy + r * Math.sin(rad(startDeg - 90));
    const x2 = cx + r * Math.cos(rad(endDeg - 90));
    const y2 = cy + r * Math.sin(rad(endDeg - 90));
    const largeArc = endDeg - startDeg > 180 ? 1 : 0;
    return (
      <path
        d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`}
        fill={color}
        opacity={0.85}
      />
    );
  }

  return (
    <svg viewBox="0 0 80 80" className="w-20 h-20">
      {arc(0, migratedAngle, "#10b981")}
      {arc(migratedAngle, 360, "#ef5350")}
      <circle cx={cx} cy={cy} r={20} fill="#0a0a1a" />
      <text x={cx} y={cy - 4} textAnchor="middle" fill="white" fontSize="9" fontWeight="bold">
        {total > 0 ? `${((migrated / total) * 100).toFixed(0)}%` : "0%"}
      </text>
      <text x={cx} y={cy + 8} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="7">
        migrated
      </text>
    </svg>
  );
}

// ── Volume Bar Chart (SVG) ────────────────────────────────────────────────────
function VolumeBars({ bins, currentVolumeM }: { bins: VolumeCorrelationBin[]; currentVolumeM: number | null }) {
  if (!bins.length) return <p className="text-[11px] text-white/40 py-2">Недостаточно данных для корреляции</p>;

  const maxMig = Math.max(...bins.map((b) => b.migrationRate), 0.01);
  const W = 280, H = 80, BAR_W = Math.floor(W / bins.length) - 4;

  return (
    <div className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20">
        {bins.map((b, i) => {
          const barH = Math.max(4, (b.migrationRate / maxMig) * (H - 20));
          const x = i * (BAR_W + 4) + 2;
          const y = H - barH - 16;
          const isOptimal = b.migrationRate === maxMig;
          return (
            <g key={i}>
              <rect x={x} y={y} width={BAR_W} height={barH} fill={isOptimal ? "#a855f7" : "#6b21a8"} rx={2} opacity={0.8} />
              <text x={x + BAR_W / 2} y={H - 4} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="6">
                {b.label.split("–")[0].replace("$", "").replace("M", "")}M
              </text>
              <text x={x + BAR_W / 2} y={y - 2} textAnchor="middle" fill="white" fontSize="7">
                {(b.migrationRate * 100).toFixed(0)}%
              </text>
            </g>
          );
        })}
        {/* Current volume marker */}
        {currentVolumeM != null && bins.length > 0 && (() => {
          const minV = bins[0].minM;
          const maxV = bins[bins.length - 1].maxM;
          const pct = Math.min(Math.max((currentVolumeM - minV) / (maxV - minV), 0), 1);
          const markerX = pct * W;
          return (
            <line x1={markerX} y1={0} x2={markerX} y2={H - 16} stroke="#facc15" strokeWidth={1.5} strokeDasharray="3,2" />
          );
        })()}
      </svg>
      <div className="flex items-center gap-3 text-[10px] text-white/40">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#a855f7] inline-block" />Лучший диапазон</span>
        {currentVolumeM != null && <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed border-yellow-400 inline-block" />Текущий объём ${currentVolumeM.toFixed(0)}M</span>}
      </div>
    </div>
  );
}

// ── Bot Risk Badge ─────────────────────────────────────────────────────────────
function BotBadge({ risk, score }: { risk: "low" | "medium" | "high"; score: number }) {
  const cfg = {
    low:    { cls: "bg-green-500/15 border-green-500/30 text-green-400",   icon: <CheckCircle className="w-3 h-3" />, label: "Low Bot Risk" },
    medium: { cls: "bg-yellow-500/15 border-yellow-500/30 text-yellow-400", icon: <AlertTriangle className="w-3 h-3" />, label: "Medium Bot Risk" },
    high:   { cls: "bg-red-500/15 border-red-500/30 text-red-400",         icon: <Bot className="w-3 h-3" />, label: "High Bot Risk" },
  }[risk];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold ${cfg.cls}`}>
      {cfg.icon}{cfg.label} ({score}/100)
    </span>
  );
}

// ── Section wrapper ────────────────────────────────────────────────────────────
function Section({ title, icon, children, defaultOpen = true }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-bg-border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-white/5 hover:bg-white/10 transition"
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-white">
          {icon}{title}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-white/40" /> : <ChevronDown className="w-4 h-4 text-white/40" />}
      </button>
      {open && <div className="p-3 border-t border-bg-border space-y-3">{children}</div>}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function DevForensicsPanel({ mint, symbol, devAddress }: Props) {
  const [twitter, setTwitter] = useState<TwitterStats | null>(null);
  const [forensics, setForensics] = useState<ForensicsResult | null>(null);
  const [loadingTw, setLoadingTw] = useState(false);
  const [loadingFo, setLoadingFo] = useState(false);
  const [errorTw, setErrorTw] = useState<string | null>(null);
  const [errorFo, setErrorFo] = useState<string | null>(null);
  const [showShillers, setShowShillers] = useState(false);

  const fetchTwitter = useCallback(async () => {
    setLoadingTw(true);
    setErrorTw(null);
    try {
      const r = await fetch(`/api/trade/dev-twitter?mint=${encodeURIComponent(mint)}&symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setTwitter(d);
    } catch (e) {
      setErrorTw((e as Error).message);
    } finally {
      setLoadingTw(false);
    }
  }, [mint, symbol]);

  const fetchForensics = useCallback(async () => {
    if (!devAddress) return;
    setLoadingFo(true);
    setErrorFo(null);
    try {
      const r = await fetch(`/api/trade/dev-forensics?creator=${encodeURIComponent(devAddress)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setForensics(d);
    } catch (e) {
      setErrorFo((e as Error).message);
    } finally {
      setLoadingFo(false);
    }
  }, [devAddress]);

  useEffect(() => {
    fetchTwitter();
    fetchForensics();
  }, [fetchTwitter, fetchForensics]);

  // ── Derive migration stats from forensics tokens for pie chart
  const migratedCount = forensics?.tokens.filter((t) => t.isMigrated).length ?? 0;
  const totalCount = forensics?.totalCreatedTokens ?? 0;

  return (
    <div className="space-y-3" data-tag="trade.dev_forensics">

      {/* ── Pie + Lifespan row ── */}
      <Section title="Token Statistics" icon={<BarChart2 className="w-4 h-4 text-neon-purple" />}>
        <div className="flex items-start gap-4">
          <div className="flex flex-col items-center gap-1">
            <PieChart migrated={migratedCount} total={totalCount} />
            <div className="flex items-center gap-2 text-[10px]">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />Migrated</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Not</span>
            </div>
          </div>
          <div className="flex-1 grid grid-cols-2 gap-2 text-xs">
            <StatCell label="Total Tokens" value={loadingFo ? "…" : totalCount.toString()} />
            <StatCell label="Migrated" value={loadingFo ? "…" : `${migratedCount} (${totalCount > 0 ? ((migratedCount / totalCount) * 100).toFixed(1) : 0}%)`} />
            <StatCell
              label="Avg Lifespan"
              value={loadingFo ? "…" : forensics?.avgLifespanHours != null ? `${forensics.avgLifespanHours.toFixed(1)}h` : "—"}
            />
            <StatCell
              label="Median Lifespan"
              value={loadingFo ? "…" : forensics?.medianLifespanHours != null ? `${forensics.medianLifespanHours.toFixed(1)}h` : "—"}
            />
          </div>
          {loadingFo && <Loader2 className="w-4 h-4 animate-spin text-neon-purple self-center" />}
        </div>
        {errorFo && <p className="text-[11px] text-red-400">{errorFo}</p>}
      </Section>

      {/* ── Volume Correlation ── */}
      <Section title="Solana Volume Correlation" icon={<TrendingUp className="w-4 h-4 text-neon-green" />}>
        {loadingFo ? (
          <div className="flex items-center gap-2 text-xs text-white/50"><Loader2 className="w-3 h-3 animate-spin" />Анализирую объёмы сети…</div>
        ) : forensics ? (
          <div className="space-y-2">
            <VolumeBars bins={forensics.volumeCorrelation} currentVolumeM={forensics.currentNetworkVolumeM} />
            <div className="grid grid-cols-2 gap-2">
              <StatCell
                label="Текущий объём"
                value={forensics.currentNetworkVolumeM != null ? `$${forensics.currentNetworkVolumeM.toFixed(0)}M` : "—"}
              />
              <StatCell
                label="Оптимальный диапазон"
                value={forensics.optimalVolumeRangeM
                  ? `$${forensics.optimalVolumeRangeM.min.toFixed(0)}M–$${forensics.optimalVolumeRangeM.max.toFixed(0)}M`
                  : "—"}
              />
            </div>
            <div className={`flex items-center gap-2 px-3 py-2 rounded border text-xs ${forensics.isOptimalLaunchTime ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"}`}>
              {forensics.isOptimalLaunchTime
                ? <><CheckCircle className="w-3.5 h-3.5" />Сейчас оптимальное время для запуска токена</>
                : <><AlertTriangle className="w-3.5 h-3.5" />Объём вне оптимального диапазона — подождите</>}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-white/40">Нет данных</p>
        )}
      </Section>

      {/* ── Twitter Analysis ── */}
      <Section title="Twitter / X Analysis" icon={<Twitter className="w-4 h-4 text-sky-400" />}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {loadingTw
              ? <span className="text-xs text-white/50 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Ищу упоминания…</span>
              : twitter
                ? <BotBadge risk={twitter.botRisk} score={twitter.botRiskScore} />
                : <span className="text-xs text-white/40">{errorTw ?? "Нет данных"}</span>
            }
            {twitter?.twitterHandle && (
              <a
                href={`https://x.com/${twitter.twitterHandle}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
              >
                @{twitter.twitterHandle}<ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={fetchTwitter}
            disabled={loadingTw}
            className="text-white/30 hover:text-white p-1 disabled:opacity-40"
            title="Обновить"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {twitter && !loadingTw && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatCell label="Tweets Found" value={twitter.totalTweets.toString()} />
            <StatCell label="Views" value={fmtNum(twitter.totalViews)} />
            <StatCell label="Total Likes" value={fmtNum(twitter.totalLikes)} />
            <StatCell label="Total Retweets" value={fmtNum(twitter.totalRetweets)} />
            <StatCell label="Unique Mentioners" value={twitter.uniqueMentioners.toString()} />
            <StatCell label="Engagement" value={fmtNum(twitter.aggregated.totalEngagement)} />
            <StatCell label="Eng. Rate" value={`${(twitter.aggregated.engagementRate * 100).toFixed(2)}%`} />
            <StatCell label="Avg Views" value={fmtNum(twitter.aggregated.avgViews)} />
            <StatCell label="Avg Like/RT" value={`${fmtNum(twitter.aggregated.avgLikes)} / ${fmtNum(twitter.aggregated.avgRetweets)}`} />
          </div>
        )}

        {/* Anomaly summary */}
        {twitter && twitter.anomalyCount > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-xs text-red-400">
            <Bot className="w-3.5 h-3.5 flex-shrink-0" />
            Обнаружено {twitter.anomalyCount} аномальных твита из {twitter.totalTweets} — возможна накрутка
          </div>
        )}
      </Section>

      {/* ── Shiller Database ── */}
      {twitter && twitter.shillers.length > 0 && (
        <Section title="Shiller Database" icon={<Users className="w-4 h-4 text-orange-400" />} defaultOpen={false}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex gap-3 text-[11px] text-white/50">
              <span>Всего: <strong className="text-white">{twitter.shillers.length}</strong></span>
              <span>Боты: <strong className="text-red-400">{twitter.shillers.filter((s) => s.isBot).length}</strong></span>
              <span>Живые: <strong className="text-green-400">{twitter.shillers.filter((s) => !s.isBot).length}</strong></span>
            </div>
            <button
              type="button"
              onClick={() => setShowShillers((v) => !v)}
              className="text-[11px] text-white/40 hover:text-white"
            >
              {showShillers ? "Скрыть" : "Показать все"}
            </button>
          </div>

          <div className="overflow-hidden rounded border border-bg-border">
            <table className="w-full text-xs">
              <thead className="bg-white/5">
                <tr className="text-white/40">
                  <th className="px-3 py-1.5 text-left">Handle</th>
                  <th className="px-3 py-1.5 text-right">Tweets</th>
                  <th className="px-3 py-1.5 text-right">Engagement</th>
                  <th className="px-3 py-1.5 text-center">Bot</th>
                </tr>
              </thead>
              <tbody>
                {(showShillers ? twitter.shillers : twitter.shillers.slice(0, 5)).map((s) => (
                  <tr key={s.handle} className="border-t border-bg-border hover:bg-white/3">
                    <td className="px-3 py-1.5">
                      <a
                        href={`https://x.com/${s.handle}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:text-sky-300 flex items-center gap-1"
                      >
                        @{s.handle}<ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </td>
                    <td className="px-3 py-1.5 text-right text-white/70">{s.tweets}</td>
                    <td className="px-3 py-1.5 text-right text-white/70">{fmtNum(s.totalEngagement)}</td>
                    <td className="px-3 py-1.5 text-center">
                      {s.isBot
                        ? <span className="text-red-400 text-[10px]">🤖 Bot</span>
                        : <span className="text-green-400 text-[10px]">✓</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Top tweets */}
          {twitter.topTweets.length > 0 && (
            <div className="space-y-1.5 mt-1">
              <p className="text-[10px] text-white/40 uppercase tracking-wider">Топ твиты</p>
              {twitter.topTweets.slice(0, 3).map((t) => (
                <div
                  key={t.id}
                  className={`px-3 py-2 rounded border text-[11px] ${t.isSuspicious ? "border-red-500/20 bg-red-500/5" : "border-bg-border bg-white/3"}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sky-400">@{t.author}</span>
                    <div className="flex items-center gap-2 text-white/40">
                      <span>👁 {fmtNum(t.views)}</span>
                      <span>♥ {t.likes}</span>
                      <span>🔁 {t.retweets}</span>
                      {t.isSuspicious && <span className="text-red-400 text-[10px]">⚠ suspicious</span>}
                    </div>
                  </div>
                  <p className="text-white/70 line-clamp-2">{t.text}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded bg-white/5 border border-bg-border">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-sm font-semibold text-white mt-0.5">{value}</div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
