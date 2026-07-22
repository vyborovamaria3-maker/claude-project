"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, Coins, Filter, Loader2, RefreshCw, Search, Wallet } from "lucide-react";

type WalletItem = {
  wallet: string;
  avgPnl: number | null;
  avgRoi: number | null;
  avgWr: number | null;
  avgMigratedPct: number | null;
  avgFastTradesPct: number | null;
  avgTotalTokens: number | null;
  avgMigratedTokens: number | null;
  totalRockets: number | null;
  reports: number | null;
  totalVolumeSol: number | null;
  totalPnlSol: number | null;
  tokensTraded: number | null;
  totalBuys: number | null;
  totalSells: number | null;
  chainWinRate: number | null;
  freshRate: number | null;
  washRate: number | null;
  bundleRows: number | null;
  positiveTokenRows: number | null;
  walletTokenRows: number | null;
  tags: string[];
};

type ParsedToken = {
  mint: string;
  ticker: string | null;
  symbol: string | null;
  name: string | null;
  creator: string | null;
  creatorSource: string | null;
  fileName: string | null;
  sheetName: string | null;
  firstRowIndex: number | null;
  totalUniqueBuyers: number | null;
  currentMc: number | null;
  marketCapMax: number | null;
  mintTimeText: string | null;
  migrationTimeText: string | null;
  timeBeforeMigrationSeconds: number | null;
  twitter: string | null;
  isMigrated: boolean;
  reached300k: boolean;
  tokenVolumeSol: number | null;
  totalTrades: number | null;
  buyTrades: number | null;
  sellTrades: number | null;
  uniqueTraders: number | null;
  tradeVolumeSol: number | null;
};

type ApiResponse = {
  items: WalletItem[];
  totalTagged: number;
  totalWallets: number;
  totalParsedTokens: number;
  parsedTokens: ParsedToken[];
  tagBreakdown: Array<{ tag: string; count: number }>;
  page: { limit: number; offset: number; returned: number };
};

const TAG_STYLES: Record<string, { cls: string; label: string }> = {
  whale: { cls: "border-sky-400/30 bg-sky-400/10 text-sky-200", label: "Whale" },
  profitable: { cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200", label: "Profitable" },
  "high-roi": { cls: "border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200", label: "High ROI" },
  sharpshooter: { cls: "border-amber-400/30 bg-amber-400/10 text-amber-200", label: "Sharpshooter" },
  sniper: { cls: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200", label: "Sniper" },
  "diamond-hands": { cls: "border-violet-400/30 bg-violet-400/10 text-violet-200", label: "Diamond hands" },
  consistent: { cls: "border-teal-400/30 bg-teal-400/10 text-teal-200", label: "Consistent" },
  loser: { cls: "border-red-400/30 bg-red-400/10 text-red-200", label: "Loser" },
  rugger: { cls: "border-rose-500/30 bg-rose-500/10 text-rose-200", label: "Rugger" },
  newbie: { cls: "border-white/20 bg-white/5 text-white/70", label: "Newbie" },
};

function fmt(value: number | null | undefined, digits = 2, suffix = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits }) + suffix;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function short(value: string | null | undefined): string {
  if (!value) return "-";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function duration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "-";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export default function WalletsFilterPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [minPnl, setMinPnl] = useState("");
  const [minRoi, setMinRoi] = useState("");
  const [minWr, setMinWr] = useState("");
  const [minMigrated, setMinMigrated] = useState("");
  const [minTokens, setMinTokens] = useState("");
  const [minReports, setMinReports] = useState("");
  const [sortBy, setSortBy] = useState("avg_pnl");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    if (tag) p.set("tag", tag);
    if (minPnl) p.set("minPnl", minPnl);
    if (minRoi) p.set("minRoi", minRoi);
    if (minWr) p.set("minWr", minWr);
    if (minMigrated) p.set("minMigrated", minMigrated);
    if (minTokens) p.set("minTokens", minTokens);
    if (minReports) p.set("minReports", minReports);
    p.set("sortBy", sortBy);
    p.set("sortDir", sortDir);
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    return p.toString();
  }, [search, tag, minPnl, minRoi, minWr, minMigrated, minTokens, minReports, sortBy, sortDir, limit, offset]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(queryString);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryString]);

  async function load(query = debouncedQuery) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/database/wallets?${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ApiResponse);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  function resetFilters() {
    setSearch("");
    setTag("");
    setMinPnl("");
    setMinRoi("");
    setMinWr("");
    setMinMigrated("");
    setMinTokens("");
    setMinReports("");
    setSortBy("avg_pnl");
    setSortDir("desc");
    setOffset(0);
  }

  const totals = useMemo(() => {
    const wallets = data?.items ?? [];
    return {
      visiblePnl: wallets.reduce((sum, item) => sum + (item.totalPnlSol ?? item.avgPnl ?? 0), 0),
      visibleVolume: wallets.reduce((sum, item) => sum + (item.totalVolumeSol ?? 0), 0),
      visibleTokens: wallets.reduce((sum, item) => sum + (item.tokensTraded ?? item.avgTotalTokens ?? 0), 0),
    };
  }, [data]);

  return (
    <div className="space-y-6" data-tag="page.database.wallets">
      <section className="surface-panel p-5 md:p-6 space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="surface-chip text-xs font-semibold text-white/85">
              <Wallet className="h-3.5 w-3.5" />
              Internal wallet analytics
            </div>
            <h1 className="max-w-3xl text-balance text-2xl font-bold tracking-tight text-white md:text-3xl">Wallets, PnL and parsed database tokens</h1>
            <p className="max-w-3xl text-sm leading-6 text-white/55">
              All data is shown inside this project: imported Excel rows, internal wallet tags, on-chain wallet stats, token trades, and parsed token metadata.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-white/55 md:grid-cols-4 lg:text-right">
            <MiniStat label="Wallets" value={fmt(data?.totalWallets, 0)} />
            <MiniStat label="Tokens parsed" value={fmt(data?.totalParsedTokens, 0)} />
            <MiniStat label="Visible PnL" value={`${fmt(totals.visiblePnl)} SOL`} />
            <MiniStat label="Visible volume" value={`${fmt(totals.visibleVolume)} SOL`} />
          </div>
        </div>

        <div className="surface-panel-hero p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <Field label="Wallet">
              <input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="address" className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white placeholder:text-white/35" />
            </Field>
            <Field label="Tag">
              <select value={tag} onChange={(e) => { setTag(e.target.value); setOffset(0); }} className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white">
                <option value="">All</option>
                {(data?.tagBreakdown ?? []).map((t) => (
                  <option key={t.tag} value={t.tag}>{TAG_STYLES[t.tag]?.label || t.tag} ({t.count})</option>
                ))}
              </select>
            </Field>
            <Field label="Min PnL">
              <input value={minPnl} onChange={(e) => { setMinPnl(e.target.value); setOffset(0); }} type="number" placeholder="0" className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white" />
            </Field>
            <Field label="Min ROI %">
              <input value={minRoi} onChange={(e) => { setMinRoi(e.target.value); setOffset(0); }} type="number" placeholder="0" className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white" />
            </Field>
            <Field label="Min WR %">
              <input value={minWr} onChange={(e) => { setMinWr(e.target.value); setOffset(0); }} type="number" placeholder="0" className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white" />
            </Field>
            <Field label="Min migrated %">
              <input value={minMigrated} onChange={(e) => { setMinMigrated(e.target.value); setOffset(0); }} type="number" placeholder="0" className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white" />
            </Field>
            <Field label="Min tokens">
              <input value={minTokens} onChange={(e) => { setMinTokens(e.target.value); setOffset(0); }} type="number" placeholder="0" className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white" />
            </Field>
            <Field label="Min reports">
              <input value={minReports} onChange={(e) => { setMinReports(e.target.value); setOffset(0); }} type="number" placeholder="1" className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white" />
            </Field>
            <Field label="Sort">
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white">
                <option value="avg_pnl">Excel avg PnL</option>
                <option value="total_pnl_sol">On-chain PnL</option>
                <option value="total_volume_sol">On-chain volume</option>
                <option value="tokens_traded">Tokens traded</option>
                <option value="chain_win_rate">On-chain winrate</option>
                <option value="avg_roi">Excel avg ROI</option>
                <option value="avg_wr">Excel avg WR</option>
                <option value="avg_migrated_pct">Migrated %</option>
                <option value="bundle_rows">Bundle rows</option>
                <option value="reports">Reports</option>
              </select>
            </Field>
            <Field label="Direction">
              <select value={sortDir} onChange={(e) => setSortDir(e.target.value as "asc" | "desc")} className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white">
                <option value="desc">Desc</option>
                <option value="asc">Asc</option>
              </select>
            </Field>
            <Field label="Limit">
              <select value={String(limit)} onChange={(e) => { setLimit(parseInt(e.target.value, 10)); setOffset(0); }} className="input h-10 rounded-lg border-bg-border/70 bg-black/20 px-3 text-white">
                {[50, 100, 200, 500].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
            <div className="col-span-2 flex items-end gap-2">
              <button onClick={() => load(queryString)} disabled={loading} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 text-sm font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-50">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Refresh
              </button>
              <button onClick={resetFilters} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-bg-border/70 bg-white/5 px-4 text-sm text-white/80 hover:bg-white/10">
                <RefreshCw className="h-4 w-4" />
                Reset
              </button>
            </div>
          </div>
        </div>
      </section>

      <TableShell
        icon={<BarChart3 className="h-3.5 w-3.5" />}
        title={`Wallet rows: ${data?.items.length ?? 0}`}
        right={
          <div className="flex items-center gap-2">
              <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))} className="rounded-md border border-bg-border/70 px-2 py-1 disabled:opacity-40">Prev</button>
            <span>offset {offset}</span>
              <button disabled={loading || (data?.items.length ?? 0) < limit} onClick={() => setOffset(offset + limit)} className="rounded-md border border-bg-border/70 px-2 py-1 disabled:opacity-40">Next</button>
          </div>
        }
      >
        {error && <div className="px-5 py-3 text-sm text-red-300">{error}</div>}
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-950/95 text-[11px] uppercase tracking-wide text-white/40">
            <tr>
              <Th>Wallet</Th>
              <Th right>Excel PnL</Th>
              <Th right>On-chain PnL</Th>
              <Th right>Volume SOL</Th>
              <Th right>ROI %</Th>
              <Th right>WR %</Th>
              <Th right>Chain WR</Th>
              <Th right>Tokens</Th>
              <Th right>Buys/Sells</Th>
              <Th right>Fresh/Wash</Th>
              <Th right>Bundles</Th>
              <Th>Tags</Th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((it) => (
              <tr key={it.wallet} className="border-t border-bg-border/70 hover:bg-white/[0.03]">
                <Td className="font-mono text-xs text-white/85">{short(it.wallet)}</Td>
                <Td right className={(it.avgPnl ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}>{fmt(it.avgPnl)}</Td>
                <Td right className={(it.totalPnlSol ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}>{fmt(it.totalPnlSol)}</Td>
                <Td right>{fmt(it.totalVolumeSol)}</Td>
                <Td right>{fmt(it.avgRoi)}</Td>
                <Td right>{fmt(it.avgWr)}</Td>
                <Td right>{pct(it.chainWinRate)}</Td>
                <Td right>{fmt(it.tokensTraded ?? it.avgTotalTokens, 0)}</Td>
                <Td right>{fmt(it.totalBuys, 0)} / {fmt(it.totalSells, 0)}</Td>
                <Td right>{pct(it.freshRate)} / {pct(it.washRate)}</Td>
                <Td right>{fmt(it.bundleRows, 0)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {it.tags.length > 0 ? it.tags.map((t) => {
                      const s = TAG_STYLES[t] || { cls: "border-bg-border/70 bg-white/5 text-white/70", label: t };
                      return <span key={t} className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${s.cls}`}>{s.label}</span>;
                    }) : <span className="text-white/35">-</span>}
                  </div>
                </Td>
              </tr>
            ))}
            {!loading && (data?.items.length ?? 0) === 0 && (
              <tr><td colSpan={12} className="px-5 py-8 text-center text-sm text-white/45">No wallets match the selected filters.</td></tr>
            )}
          </tbody>
        </table>
      </TableShell>

      <TableShell icon={<Coins className="h-3.5 w-3.5" />} title="Parsed tokens from database" right={<span>{fmt(data?.totalParsedTokens, 0)} total</span>}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-950/95 text-[11px] uppercase tracking-wide text-white/40">
            <tr>
              <Th>Token</Th>
              <Th>Ticker</Th>
              <Th>Creator</Th>
              <Th>Source</Th>
              <Th right>ATH / MC</Th>
              <Th right>Buyers</Th>
              <Th right>Trades</Th>
              <Th right>Volume SOL</Th>
              <Th>Mint time</Th>
              <Th>Migration</Th>
              <Th right>To migration</Th>
              <Th>Flags</Th>
            </tr>
          </thead>
          <tbody>
            {(data?.parsedTokens ?? []).map((token) => (
              <tr key={token.mint} className="border-t border-bg-border/70 hover:bg-white/[0.03]">
                <Td className="font-mono text-xs">
                  <div className="text-white/85">{short(token.mint)}</div>
                  <div className="mt-1 text-[10px] text-white/35">{token.name || token.symbol || "-"}</div>
                </Td>
                <Td>{token.ticker || token.symbol || "-"}</Td>
                <Td className="font-mono text-xs">{short(token.creator)}</Td>
                <Td>
                  <div>{token.fileName || "-"}</div>
                  <div className="mt-1 text-[10px] text-white/35">{token.sheetName || "-"} row {token.firstRowIndex ?? "-"}</div>
                </Td>
                <Td right>${fmt(token.marketCapMax ?? token.currentMc, 0)}</Td>
                <Td right>{fmt(token.totalUniqueBuyers ?? token.uniqueTraders, 0)}</Td>
                <Td right>{fmt(token.totalTrades, 0)} ({fmt(token.buyTrades, 0)}/{fmt(token.sellTrades, 0)})</Td>
                <Td right>{fmt(token.tradeVolumeSol ?? token.tokenVolumeSol)}</Td>
                <Td>{token.mintTimeText || "-"}</Td>
                <Td>{token.migrationTimeText || "-"}</Td>
                <Td right>{duration(token.timeBeforeMigrationSeconds)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {token.isMigrated && <Badge tone="green">Migrated</Badge>}
                    {token.reached300k && <Badge tone="sky">300k</Badge>}
                    {token.twitter && <Badge tone="violet">X</Badge>}
                    {!token.isMigrated && !token.reached300k && !token.twitter && <span className="text-white/35">-</span>}
                  </div>
                </Td>
              </tr>
            ))}
            {!loading && (data?.parsedTokens.length ?? 0) === 0 && (
              <tr><td colSpan={12} className="px-5 py-8 text-center text-sm text-white/45">No parsed tokens found in migration_token_rows.</td></tr>
            )}
          </tbody>
        </table>
      </TableShell>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-panel-hero px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-white/35">{label}</div>
      <div className="mt-1 font-semibold text-white">{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-white/40">{label}</div>
      {children}
    </label>
  );
}

function TableShell({ icon, title, right, children }: { icon: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="surface-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-bg-border/70 px-5 py-3 text-xs text-white/55">
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5" />
          {icon}
          <span>{title}</span>
        </div>
        {right}
      </div>
      <div className="max-h-[620px] overflow-auto">{children}</div>
    </section>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "green" | "sky" | "violet" }) {
  const cls = {
    green: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
    sky: "border-sky-400/25 bg-sky-400/10 text-sky-200",
    violet: "border-violet-400/25 bg-violet-400/10 text-violet-200",
  }[tone];
  return <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{children}</span>;
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`whitespace-nowrap px-3 py-2 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

function Td({ children, right = false, className = "" }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 text-white/80 ${right ? "text-right" : "text-left"} ${className}`}>{children}</td>;
}
