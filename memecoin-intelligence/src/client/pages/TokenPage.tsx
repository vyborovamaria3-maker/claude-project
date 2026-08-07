import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiQuery, apiMutation, createQueryKey } from '@/client/lib/api';
import toast from 'react-hot-toast';
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  Copy,
  Minus,
  RefreshCw,
  RotateCw,
  Trash2,
  Users,
} from 'lucide-react';
 
import Page from '@/client/components/Page';
import { Button } from '@/client/components/ui/Button';
import { Input } from '@/client/components/ui/Input';
import { cn } from '@/client/lib/utils';
import MentionResults from './MentionResults';
import { CommunityLink, TokenAvatar, XLinkNote, formatUsd, shortAddress } from './token-ui';
 
type TokenDetail = {
  id: string;
  mintAddress: string;
  symbol: string;
  name: string | null;
  imageUri: string | null;
  xUrl: string | null;
  xLinkKind: string | null;
  communityUrl: string | null;
  usdMarketCap: number | null;
  launchedAt: string | null;
  metadataSyncedAt: string | null;
  mentions: number;
  prevMentions: number;
  delta: number;
  lastRecordedAt: string | null;
  createdAt: string;
  rank: number;
  watchlistSize: number;
  totalMentions: number;
};
 
const numberFormat = new Intl.NumberFormat('en-US');
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
 
function formatAbsolute(value: string | null) {
  if (!value) return 'never';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
 
export default function TokenPage() {
  const { address = '' } = useParams<{ address: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isValid = SOLANA_ADDRESS_REGEX.test(address);
 
  const { data: token, isLoading } = useQuery({
    ...apiQuery<TokenDetail | null>('xanalysis.getToken', { address }),
    enabled: isValid,
  });
 
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: createQueryKey('xanalysis.getToken', { address }),
    });
    queryClient.invalidateQueries({ queryKey: createQueryKey('xanalysis.listTokens', {}) });
  }, [queryClient, address]);
 
  const { mutate: refreshMetadata, isPending: isRefreshing } = useMutation({
    ...apiMutation('xanalysis.refreshMetadata'),
    onSuccess: () => {
      invalidate();
      toast.success('Metadata refreshed from pump.fun');
    },
    onError: (error: Error) => toast.error(error.message),
  });
 
  const { mutate: removeToken, isPending: isRemoving } = useMutation({
    ...apiMutation('xanalysis.removeToken'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: createQueryKey('xanalysis.listTokens', {}) });
      toast.success('Removed from watchlist');
      navigate('/');
    },
    onError: (error: Error) => toast.error(error.message),
  });
 
  if (isLoading) {
    return <Page seo={{ title: 'Token' }} isLoading />;
  }
 
  if (!token) {
    return (
      <Page seo={{ title: 'Token not watched', noindex: true }}>
        <BackLink />
        <div className="animate-fade-in rounded-[var(--radius-card)] border border-ink-600 bg-ink-800 px-6 py-16 text-center">
          <h1 className="text-xl font-semibold text-chalk">
            {isValid ? 'This token is not on the watchlist' : 'Invalid contract address'}
          </h1>
          <p className="mt-2 text-sm text-chalk-dim">
            {isValid ? (
              <>
                Look up <span className="tabular">{shortAddress(address, 6, 6)}</span> on the home
                page to add it.
              </>
            ) : (
              'That is not a valid Solana contract address.'
            )}
          </p>
          <Link to="/" className="mt-6 inline-block">
            <Button color="primary">Back to lookup</Button>
          </Link>
        </div>
      </Page>
    );
  }
 
  const share = token.totalMentions > 0 ? (token.mentions / token.totalMentions) * 100 : 0;
  const changePct = token.prevMentions > 0 ? (token.delta / token.prevMentions) * 100 : null;
 
  return (
    <Page
      seo={{
        title: `$${token.symbol}`,
        description: `Mention activity and X community group for $${token.symbol} (${shortAddress(
          token.mintAddress
        )}).`,
      }}
    >
      <BackLink />
 
      <header className="animate-slide-up flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <TokenAvatar imageUri={token.imageUri} symbol={token.symbol} size="lg" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-chalk-faint">
              <span className="inline-flex size-1.5 animate-pulse-signal rounded-full bg-signal" />
              Rank {token.rank} of {token.watchlistSize}
            </div>
            <h1 className="font-display text-4xl font-semibold tracking-tight text-chalk">
              ${token.symbol}
            </h1>
            {token.name && <p className="text-sm text-chalk-dim">{token.name}</p>}
            <AddressLine address={token.mintAddress} />
          </div>
        </div>
 
        <div className="flex flex-wrap items-center gap-2">
          <RecordControl tokenId={token.id} mentions={token.mentions} onSaved={invalidate} />
          <Button
            variant="ghost"
            aria-label="Refresh metadata"
            loading={isRefreshing}
            leftIcon={<RotateCw className="size-4" />}
            onClick={() => refreshMetadata({ address: token.mintAddress })}
          >
            Sync
          </Button>
          <Button
            variant="ghost"
            color="destructive"
            aria-label="Remove from watchlist"
            loading={isRemoving}
            onClick={() => removeToken({ address: token.mintAddress })}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </header>
 
      <section
        className="grid animate-fade-in grid-cols-2 gap-3 lg:grid-cols-4"
        aria-label="Token metrics"
      >
        <Metric label="Mentions" value={numberFormat.format(token.mentions)} />
        <Metric
          label="Change"
          value={`${token.delta > 0 ? '+' : ''}${numberFormat.format(token.delta)}`}
          tone={token.delta > 0 ? 'up' : token.delta < 0 ? 'down' : 'flat'}
        />
        <Metric
          label="Change %"
          value={changePct === null ? '—' : `${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%`}
          tone={changePct === null ? 'flat' : changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat'}
        />
        <Metric label="Share of voice" value={`${share.toFixed(1)}%`} />
      </section>
 
      <section className="animate-fade-in rounded-[var(--radius-card)] border border-ink-600 bg-ink-800 p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-chalk-faint">
          <Users className="size-3.5" aria-hidden="true" />
          Community group
        </div>
        <div className="mt-3">
          {token.communityUrl ? (
            <CommunityLink url={token.communityUrl} />
          ) : (
            <XLinkNote kind={token.xLinkKind} url={token.xUrl} />
          )}
        </div>
      </section>

      <MentionResults address={token.mintAddress} symbol={token.symbol} />
 
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <section className="animate-fade-in rounded-[var(--radius-card)] border border-ink-600 bg-ink-800 p-5">
          <h2 className="text-sm font-semibold text-chalk">Last two readings</h2>
          <p className="mt-1 text-xs text-chalk-faint">
            Only the current and previous counts are stored — full history is not tracked yet.
          </p>
 
          <div className="mt-5 space-y-3">
            <ReadingBar
              label="Current"
              value={token.mentions}
              max={Math.max(token.mentions, token.prevMentions, 1)}
              accent
            />
            <ReadingBar
              label="Previous"
              value={token.prevMentions}
              max={Math.max(token.mentions, token.prevMentions, 1)}
            />
          </div>
        </section>
 
        <section className="animate-fade-in rounded-[var(--radius-card)] border border-ink-600 bg-ink-800 p-5">
          <h2 className="text-sm font-semibold text-chalk">Details</h2>
          <dl className="mt-4 divide-y divide-ink-700 text-sm">
            <DetailRow label="Market cap" value={formatUsd(token.usdMarketCap)} />
            <DetailRow label="Launched" value={formatAbsolute(token.launchedAt)} />
            <DetailRow label="Last reading" value={formatAbsolute(token.lastRecordedAt)} />
            <DetailRow label="Metadata synced" value={formatAbsolute(token.metadataSyncedAt)} />
            <DetailRow label="Added" value={formatAbsolute(token.createdAt)} />
            <DetailRow label="Tracked volume" value={numberFormat.format(token.totalMentions)} />
          </dl>
        </section>
      </div>
    </Page>
  );
}
 
function AddressLine({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
 
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not copy the address');
    }
  };
 
  return (
    <button
      type="button"
      onClick={copy}
      className="tabular group flex max-w-full items-center gap-1.5 text-[11px] text-chalk-faint transition-colors duration-150 hover:text-chalk-dim"
    >
      <span className="truncate">{address}</span>
      <Copy
        className={cn(
          'size-3 shrink-0 transition-colors duration-150',
          copied ? 'text-signal' : 'opacity-0 group-hover:opacity-100'
        )}
        aria-hidden="true"
      />
      <span className="sr-only">Copy contract address</span>
    </button>
  );
}
 
function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex w-fit items-center gap-1.5 text-xs text-chalk-faint transition-colors duration-150 hover:text-chalk-dim"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Lookup
    </Link>
  );
}
 
function Metric({
  label,
  value,
  tone = 'flat',
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'flat';
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-ink-600 bg-ink-800 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-chalk-faint">{label}</div>
      <div
        className={cn(
          'tabular mt-1.5 flex items-center gap-1 text-xl font-semibold',
          tone === 'up' && 'text-signal',
          tone === 'down' && 'text-ember',
          tone === 'flat' && 'text-chalk'
        )}
      >
        {tone === 'up' && <ArrowUpRight className="size-4" aria-hidden="true" />}
        {tone === 'down' && <ArrowDownRight className="size-4" aria-hidden="true" />}
        {tone === 'flat' && value !== '—' && (
          <Minus className="size-4 text-chalk-faint" aria-hidden="true" />
        )}
        {value}
      </div>
    </div>
  );
}
 
function ReadingBar({
  label,
  value,
  max,
  accent = false,
}: {
  label: string;
  value: number;
  max: number;
  accent?: boolean;
}) {
  const width = Math.max((value / max) * 100, value > 0 ? 2 : 0);
 
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.18em] text-chalk-faint">{label}</span>
        <span className="tabular text-sm font-medium text-chalk">
          {numberFormat.format(value)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-[var(--radius-panel)] bg-ink-700">
        <div
          className={cn(
            'h-full rounded-[var(--radius-panel)] transition-all duration-500',
            accent ? 'bg-signal' : 'bg-ink-500'
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
 
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-xs uppercase tracking-[0.14em] text-chalk-faint">{label}</dt>
      <dd className="tabular truncate text-right text-chalk-dim">{value}</dd>
    </div>
  );
}
 
function RecordControl({
  tokenId,
  mentions,
  onSaved,
}: {
  tokenId: string;
  mentions: number;
  onSaved: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(String(mentions));
 
  const { mutate: recordMentions, isPending } = useMutation({
    ...apiMutation('xanalysis.recordMentions'),
    onSuccess: () => {
      setIsEditing(false);
      onSaved();
      toast.success('Reading recorded');
    },
    onError: (error: Error) => toast.error(error.message),
  });
 
  const submit = () => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error('Enter a valid mention count');
      return;
    }
    recordMentions({ tokenId, mentions: Math.round(parsed) });
  };
 
  if (!isEditing) {
    return (
      <Button
        variant="outline"
        leftIcon={<RefreshCw className="size-4" />}
        onClick={() => {
          setValue(String(mentions));
          setIsEditing(true);
        }}
      >
        Record reading
      </Button>
    );
  }
 
  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') setIsEditing(false);
        }}
        className="tabular w-28"
        aria-label="New mention count"
      />
      <Button color="primary" loading={isPending} onClick={submit}>
        Save
      </Button>
      <Button variant="ghost" onClick={() => setIsEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}
