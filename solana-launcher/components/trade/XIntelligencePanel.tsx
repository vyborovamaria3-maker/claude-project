"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BadgeCheck,
  Bot,
  Eye,
  Heart,
  Loader2,
  RefreshCw,
  Repeat2,
  Search,
  ShieldAlert,
  Twitter,
  Users,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";
import {
  DEFAULT_SOCIAL_OPTIONS,
  MINT_RE,
  type Lookback,
  type SocialOptions,
  type TwitterStats,
} from "@/lib/trade/social-intelligence";
import { buildSocialSourceParams, fetchJson } from "@/lib/trade/social-intelligence-api";

const LOOKBACKS: Array<[Lookback, string]> = [
  ["1", "1 час"],
  ["6", "6 часов"],
  ["24", "24 часа"],
  ["72", "3 дня"],
  ["168", "7 дней"],
  ["720", "30 дней"],
  ["all", "Всё"],
];

export default function XIntelligencePanel() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMintRef = useRef(params.get("mint")?.trim() || "");
  const initialMint = initialMintRef.current;

  const [query, setQuery] = useState(initialMint);
  const [mint, setMint] = useState(initialMint);
  const [options, setOptions] = useState<SocialOptions>(DEFAULT_SOCIAL_OPTIONS);
  const [data, setData] = useState<TwitterStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (next: string) => {
      const contract = next.trim();
      if (!MINT_RE.test(contract)) {
        setError("Введи корректный Solana mint / CA.");
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setMint(contract);
      setQuery(contract);
      setLoading(true);
      setError(null);
      router.replace(`/trade/analysis/x?mint=${encodeURIComponent(contract)}`, { scroll: false });

      try {
        const { x } = buildSocialSourceParams(contract, options);
        const result = await fetchJson<TwitterStats>(
          `/api/trade/dev-twitter?${x}`,
          controller.signal,
        );
        if (!controller.signal.aborted) setData(result);
      } catch (value: unknown) {
        if (!controller.signal.aborted) {
          const message = value instanceof Error ? value.message : "X analysis unavailable";
          setData(null);
          setError(message);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [options, router],
  );

  useEffect(() => {
    if (initialMint && MINT_RE.test(initialMint)) void run(initialMint);
    return () => abortRef.current?.abort();
    // Initial URL mint is intentionally analyzed only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(query);
  };

  const risk = data?.riskUniverse;
  const suspiciousTweets = risk?.suspiciousTweets ?? 0;
  const botAccounts = risk?.botAccounts ?? 0;
  const verifiedAuthors = data?.aggregated.verifiedAuthors ?? 0;

  return (
    <div className="space-y-5" data-tag="trade.x_intelligence.v1">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Twitter className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold text-content">X Intelligence</h1>
          </div>
          <p className="mt-1 text-xs text-content-muted">
            Отдельный X-анализ: охват, вовлечённость, авторы, боты, подозрительные публикации и топ-посты.
          </p>
        </div>
        {mint && (
          <div className="font-mono text-[10px] text-content-faint">
            {mint.slice(0, 8)}…{mint.slice(-7)}
          </div>
        )}
      </header>

      <form onSubmit={submit} className="surface-panel rounded-2xl border border-bg-border p-4">
        <div className="grid gap-3 lg:grid-cols-[1.45fr_.5fr_.5fr_.42fr]">
          <Field label="Solana mint / CA">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className={`${siteDesign.controls.inputClassName} pl-9 font-mono`}
                placeholder="Вставь contract"
              />
            </div>
          </Field>
          <Field label="Ticker">
            <input
              value={options.symbol}
              onChange={(event) => setOptions((value) => ({ ...value, symbol: event.target.value }))}
              className={siteDesign.controls.inputClassName}
              placeholder="BONK"
            />
          </Field>
          <Field label="Период">
            <select
              value={options.lookback}
              onChange={(event) =>
                setOptions((value) => ({ ...value, lookback: event.target.value as Lookback }))
              }
              className={siteDesign.controls.inputClassName}
            >
              {LOOKBACKS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button disabled={loading} className={`${siteDesign.controls.primaryActionClassName} w-full`}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Twitter className="h-4 w-4" />}
              Анализ X
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="X posts">
            <input
              type="number"
              min={10}
              max={100}
              value={options.xLimit}
              onChange={(event) =>
                setOptions((value) => ({
                  ...value,
                  xLimit: Math.max(10, Math.min(100, Number(event.target.value) || 10)),
                }))
              }
              className={siteDesign.controls.inputClassName}
            />
          </Field>
          <Check
            label="Verified X only"
            value={options.xVerifiedOnly}
            set={(checked) => setOptions((value) => ({ ...value, xVerifiedOnly: checked }))}
          />
          <Check
            label="Exclude suspicious X"
            value={options.xExcludeSuspicious}
            set={(checked) => setOptions((value) => ({ ...value, xExcludeSuspicious: checked }))}
          />
        </div>
      </form>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger">
          {error}
        </div>
      )}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            <Kpi label="Posts" value={formatNumber(data.totalTweets)} icon={<Twitter />} />
            <Kpi label="Views" value={formatNumber(data.totalViews)} icon={<Eye />} />
            <Kpi label="Likes" value={formatNumber(data.totalLikes)} icon={<Heart />} />
            <Kpi label="Reposts" value={formatNumber(data.totalRetweets)} icon={<Repeat2 />} />
            <Kpi label="Authors" value={formatNumber(data.uniqueMentioners)} icon={<Users />} />
            <Kpi label="Verified" value={formatNumber(verifiedAuthors)} icon={<BadgeCheck />} />
            <Kpi label="Bot risk" value={`${Math.round(data.botRiskScore)} / 100`} icon={<Bot />} />
            <Kpi label="Anomalies" value={formatNumber(data.anomalyCount)} icon={<ShieldAlert />} />
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <Panel title="Качество выборки">
              <Rows
                rows={[
                  ["Engagement", formatNumber(data.aggregated.totalEngagement)],
                  ["Engagement rate", formatPercent(data.aggregated.engagementRate)],
                  ["Bot ratio", formatPercent(data.aggregated.botRatio)],
                  ["Suspicious posts", formatNumber(suspiciousTweets)],
                  ["Bot accounts", formatNumber(botAccounts)],
                  ["Sample limit", formatNumber(data.sampleLimit ?? data.totalTweets)],
                  ["Collection", data.collectionStrategy || "—"],
                  ["Truncated", data.collectionTruncated ? "Да" : "Нет"],
                ]}
              />
            </Panel>

            <Panel title="Топ авторы">
              <div className="space-y-2">
                {data.shillers.length === 0 && <Empty />}
                {data.shillers.slice(0, 12).map((author) => (
                  <div key={author.handle} className="flex items-center justify-between gap-3 rounded-xl border border-bg-border px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-content">
                        <span className="truncate">@{author.handle}</span>
                        {author.isVerified && <BadgeCheck className="h-3.5 w-3.5 text-primary" />}
                        {author.isBot && <Bot className="h-3.5 w-3.5 text-warning" />}
                      </div>
                      <div className="mt-0.5 text-[10px] text-content-faint">
                        {formatNumber(author.tweets)} posts · {formatNumber(author.followers ?? 0)} followers
                      </div>
                    </div>
                    <div className="text-right text-[10px] text-content-muted">
                      {formatNumber(author.totalEngagement)} eng.
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </section>

          <Panel title="Топ публикации X">
            <div className="space-y-3">
              {data.topTweets.length === 0 && <Empty />}
              {data.topTweets.slice(0, 20).map((tweet) => (
                <article key={tweet.id} className="rounded-xl border border-bg-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-content">
                      <span>@{tweet.author}</span>
                      {tweet.isSuspicious && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 px-2 py-0.5 text-[9px] text-warning">
                          <ShieldAlert className="h-3 w-3" /> suspicious
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] text-content-faint">{formatTimestamp(tweet.timestamp)}</div>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-content-muted">{tweet.text}</p>
                  <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-content-faint">
                    <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" />{formatNumber(tweet.views)}</span>
                    <span className="inline-flex items-center gap-1"><Heart className="h-3 w-3" />{formatNumber(tweet.likes)}</span>
                    <span className="inline-flex items-center gap-1"><Repeat2 className="h-3 w-3" />{formatNumber(tweet.retweets)}</span>
                  </div>
                </article>
              ))}
            </div>
          </Panel>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void run(mint)}
              disabled={loading || !mint}
              className={siteDesign.controls.actionButtonClassName}
            >
              <RefreshCw className="h-4 w-4" />
              Обновить X
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-content-faint">{label}</span>
      {children}
    </label>
  );
}

function Check({ label, value, set }: { label: string; value: boolean; set: (value: boolean) => void }) {
  return (
    <label className="flex min-h-10 items-center gap-2 rounded-xl border border-bg-border px-3 text-xs text-content-muted">
      <input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} />
      {label}
    </label>
  );
}

function Kpi({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="surface-panel rounded-2xl border border-bg-border p-3">
      <div className="flex items-center gap-1.5 text-content-faint [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}<span className="text-[9px] uppercase tracking-wider">{label}</span></div>
      <div className="mt-2 text-lg font-semibold text-content">{value}</div>
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

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="divide-y divide-bg-border">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-2 text-xs">
          <span className="text-content-muted">{label}</span>
          <span className="font-medium text-content">{value}</span>
        </div>
      ))}
    </div>
  );
}

function Empty() {
  return <div className="py-6 text-center text-xs text-content-faint">Нет данных</div>;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { notation: Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  return `${normalized.toFixed(1)}%`;
}

function formatTimestamp(value: number | null) {
  if (!value) return "—";
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU");
}
