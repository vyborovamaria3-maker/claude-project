import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiQuery, apiMutation, createQueryKey } from '@/client/lib/api';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Globe,
  Minus,
  Plus,
  Radar,
  Search,
  Users,
} from 'lucide-react';
 
import Page from '@/client/components/Page';
import { Button } from '@/client/components/ui/Button';
import { Input } from '@/client/components/ui/Input';
import { cn } from '@/client/lib/utils';
import { CommunityLink, TokenAvatar, XLinkNote, formatUsd, shortAddress } from './token-ui';
import MentionResults from './MentionResults';
 
type WatchedToken = {
  id: string;
  mintAddress: string;
  symbol: string;
  name: string | null;
  imageUri: string | null;
  xUrl: string | null;
  xLinkKind: string | null;
  communityUrl: string | null;
  usdMarketCap: number | null;
  mentions: number;
  delta: number;
  lastRecordedAt: string | null;
};
 
type LookupResult =
  | { status: 'error'; message: string }
  | { status: 'not_found'; address: string }
  | {
      status: 'found';
      isWatched: boolean;
      token: {
        mintAddress: string;
        symbol: string;
        name: string;
        description: string | null;
        imageUri: string | null;
        xUrl: string | null;
        xLinkKind: string | null;
        xLinkRef: string | null;
        communityUrl: string | null;
        website: string | null;
        usdMarketCap: number | null;
        athUsdMarketCap: number | null;
        replyCount: number | null;
        isComplete: boolean;
        launchedAt: string | null;
      };
    };
 
const numberFormat = new Intl.NumberFormat('en-US');
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
 
function formatRelative(value: string | null) {
  if (!value) return 'never';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
 
export default function HomePage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [address, setAddress] = useState('');
 
  const { data: tokens = [], isLoading } = useQuery(
    apiQuery<WatchedToken[]>('xanalysis.listTokens', {})
  );
 
  const { data: lookup, isFetching: isLooking } = useQuery({
    ...apiQuery<LookupResult>('xanalysis.lookupToken', { address }),
    enabled: SOLANA_ADDRESS_REGEX.test(address),
    staleTime: 30_000,
  });
 
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: createQueryKey('xanalysis.listTokens', {}) });
    if (address) {
      queryClient.invalidateQueries({
        queryKey: createQueryKey('xanalysis.lookupToken', { address }),
      });
    }
  }, [queryClient, address]);
 
  const handleSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!SOLANA_ADDRESS_REGEX.test(trimmed)) {
      toast.error('Paste a valid Solana contract address');
      return;
    }
    setAddress(trimmed);
  };
 
  return (
    <Page
      seo={{
        title: 'X Analysis',
        description:
          'Look up a Solana token by contract address, find its X community group, and track how often it is mentioned.',
      }}
    >
      <header className="animate-slide-up space-y-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-chalk-faint">
          <span className="inline-flex size-1.5 animate-pulse-signal rounded-full bg-signal" />
          Contract lookup
        </div>
        <h1 className="text-3xl font-semibold text-chalk">X Analysis</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-chalk-dim">
          Paste a pump.fun contract address. We resolve the token on-chain identity and surface
          its X community group when the creator set one.
        </p>
      </header>
 
      <form onSubmit={handleSearch} className="animate-fade-in flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-chalk-faint"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="3VFnDoACa991DYe987w354sbvmhqjjzC4Z31SoZepump"
            autoComplete="off"
            spellCheck={false}
            aria-label="Solana contract address"
            className="tabular w-full pl-9 text-xs sm:text-sm"
          />
        </div>
        <Button type="submit" color="primary" loading={isLooking}>
          Look up
        </Button>
      </form>
 
      {address && !isLooking && lookup && (
        <LookupPanel result={lookup} onAdded={invalidate} />
      )}
 
      {lookup?.status === 'found' && (
        <MentionResults
          address={lookup.token.mintAddress}
          symbol={lookup.token.symbol}
        />
      )}
 
      <Watchlist tokens={tokens} isLoading={isLoading} />
    </Page>
  );
}
 
function LookupPanel({ result, onAdded }: { result: LookupResult; onAdded: () => void }) {
  const { mutate: addToken, isPending } = useMutation({
    ...apiMutation('xanalysis.addToken'),
    onSuccess: (data) => {
      onAdded();
      toast.success(`$${(data as { symbol: string }).symbol} added to watchlist`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
 
  if (result.status === 'error') {
    return (
      <Notice tone="ember" icon={<AlertTriangle className="size-4" />}>
        pump.fun lookup failed: {result.message}
      </Notice>
    );
  }
 
  if (result.status === 'not_found') {
    return (
      <Notice tone="amber" icon={<AlertTriangle className="size-4" />}>
        pump.fun has no token at{' '}
        <span className="tabular">{shortAddress(result.address)}</span>. Check the address, or the
        token may not be a pump.fun launch.
      </Notice>
    );
  }
 
  const { token, isWatched } = result;
 
  return (
    <section className="animate-slide-up overflow-hidden rounded-[var(--radius-card)] border border-ink-600 bg-ink-800">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-700 p-5">
        <div className="flex min-w-0 items-start gap-4">
          <TokenAvatar imageUri={token.imageUri} symbol={token.symbol} size="lg" />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-chalk">
                ${token.symbol}
              </h2>
              <span className="truncate text-sm text-chalk-dim">{token.name}</span>
            </div>
            <div className="tabular text-[11px] text-chalk-faint">{token.mintAddress}</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-[11px] text-chalk-faint">
              <span>mcap {formatUsd(token.usdMarketCap)}</span>
              <span>ath {formatUsd(token.athUsdMarketCap)}</span>
              <span>{token.isComplete ? 'bonded' : 'on curve'}</span>
              {token.website && (
                <a
                  href={token.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 transition-colors duration-150 hover:text-chalk-dim"
                >
                  <Globe className="size-3" aria-hidden="true" />
                  website
                </a>
              )}
            </div>
          </div>
        </div>
 
        <div className="flex shrink-0 items-center gap-2">
          <Link to={`/token/${token.mintAddress}`}>
            <Button variant="outline">Open</Button>
          </Link>
          {isWatched ? (
            <Button color="primary" variant="soft" disabled leftIcon={<Check className="size-4" />}>
              Watching
            </Button>
          ) : (
            <Button
              color="primary"
              loading={isPending}
              leftIcon={<Plus className="size-4" />}
              onClick={() => addToken({ address: token.mintAddress })}
            >
              Watch
            </Button>
          )}
        </div>
      </div>
 
      <div className="p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-chalk-faint">
          <Users className="size-3.5" aria-hidden="true" />
          Community group
        </div>
        <div className="mt-3">
          {token.communityUrl ? (
            <CommunityLink url={token.communityUrl} />
          ) : (
            <XLinkNote kind={token.xLinkKind} url={token.xUrl} ref={token.xLinkRef} />
          )}
        </div>
      </div>
    </section>
  );
}
 
function Notice({
  tone,
  icon,
  children,
}: {
  tone: 'amber' | 'ember';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'animate-fade-in flex items-start gap-3 rounded-[var(--radius-card)] border px-4 py-3 text-xs leading-relaxed',
        tone === 'amber'
          ? 'border-amber/25 bg-amber/5 text-chalk-dim'
          : 'border-ember/30 bg-ember-glow text-chalk-dim'
      )}
    >
      <span className={cn('mt-0.5 shrink-0', tone === 'amber' ? 'text-amber' : 'text-ember')}>
        {icon}
      </span>
      <p>{children}</p>
    </div>
  );
}
 
function Watchlist({ tokens, isLoading }: { tokens: WatchedToken[]; isLoading: boolean }) {
  return (
    <section className="animate-fade-in overflow-hidden rounded-[var(--radius-card)] border border-ink-600 bg-ink-800">
      <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
        <h2 className="text-sm font-semibold text-chalk">Watchlist</h2>
        <span className="tabular text-xs text-chalk-faint">
          {isLoading ? '—' : `${tokens.length} tracked`}
        </span>
      </div>
 
      {isLoading ? (
        <div className="divide-y divide-ink-700">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between px-5 py-4">
              <div className="h-4 w-32 animate-pulse rounded-[var(--radius-panel)] bg-ink-700" />
              <div className="h-4 w-16 animate-pulse rounded-[var(--radius-panel)] bg-ink-700" />
            </div>
          ))}
        </div>
      ) : tokens.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <span className="flex size-10 items-center justify-center rounded-[var(--radius-card)] bg-ink-700">
            <Radar className="size-5 text-chalk-faint" aria-hidden="true" />
          </span>
          <p className="text-sm text-chalk-dim">Nothing on the watchlist yet.</p>
          <p className="max-w-xs text-xs text-chalk-faint">
            Look up a contract address above, then hit Watch to keep it here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-ink-700">
          {tokens.map((token, index) => (
            <li
              key={token.id}
              className="animate-ticker-in transition-colors duration-150 hover:bg-ink-700/60"
              style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            >
              <Link
                to={`/token/${token.mintAddress}`}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <TokenAvatar imageUri={token.imageUri} symbol={token.symbol} />
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-display text-base font-semibold tracking-tight text-chalk">
                        ${token.symbol}
                      </span>
                      {token.name && (
                        <span className="truncate text-xs text-chalk-faint">{token.name}</span>
                      )}
                      {token.communityUrl && (
                        <span className="inline-flex items-center gap-1 rounded-[var(--radius-panel)] bg-signal-glow px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-signal">
                          <Users className="size-2.5" aria-hidden="true" />
                          community
                        </span>
                      )}
                    </div>
                    <div className="tabular mt-1 text-[11px] text-chalk-faint">
                      {shortAddress(token.mintAddress)} · {formatRelative(token.lastRecordedAt)}
                    </div>
                  </div>
                </div>
 
                <div className="flex items-center gap-5">
                  <div className="text-right">
                    <div className="tabular text-lg font-semibold text-chalk">
                      {numberFormat.format(token.mentions)}
                    </div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-chalk-faint">
                      mentions
                    </div>
                  </div>
                  <DeltaChip delta={token.delta} hasHistory={token.lastRecordedAt !== null} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
 
function DeltaChip({ delta, hasHistory }: { delta: number; hasHistory: boolean }) {
  if (!hasHistory || delta === 0) {
    return (
      <span className="tabular inline-flex items-center gap-1 rounded-[var(--radius-panel)] bg-ink-700 px-2 py-1 text-xs text-chalk-faint">
        <Minus className="size-3" aria-hidden="true" />
        flat
      </span>
    );
  }
 
  const isUp = delta > 0;
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-1 rounded-[var(--radius-panel)] px-2 py-1 text-xs font-medium',
        isUp ? 'bg-signal-glow text-signal' : 'bg-ember-glow text-ember'
      )}
    >
      {isUp ? (
        <ArrowUpRight className="size-3" aria-hidden="true" />
      ) : (
        <ArrowDownRight className="size-3" aria-hidden="true" />
      )}
      {isUp ? '+' : ''}
      {numberFormat.format(delta)}
    </span>
  );
}
 