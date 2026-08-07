/**
 * Small presentational pieces shared by the contract lookup on the home page
 * and the token detail page.
 */
 
import { ExternalLink, Link2, MessageSquare, Search, Users } from 'lucide-react';
import { cn } from '@/client/lib/utils';
 
export function shortAddress(address: string, lead = 4, tail = 4) {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
 
export function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}
 
export function TokenAvatar({
  imageUri,
  symbol,
  size = 'md',
}: {
  imageUri: string | null;
  symbol: string;
  size?: 'md' | 'lg';
}) {
  const dimension = size === 'lg' ? 'size-14' : 'size-9';
 
  if (!imageUri) {
    return (
      <span
        className={cn(
          dimension,
          'flex shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-ink-700 font-display text-xs font-semibold text-chalk-faint'
        )}
        aria-hidden="true"
      >
        {symbol.slice(0, 3) || '?'}
      </span>
    );
  }
 
  return (
    <img
      src={imageUri}
      alt=""
      loading="lazy"
      className={cn(
        dimension,
        'shrink-0 rounded-[var(--radius-card)] border border-ink-600 bg-ink-700 object-cover'
      )}
    />
  );
}
 
/** The happy path: the token has a real X community group. */
export function CommunityLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-signal/30 bg-signal-glow px-4 py-3 transition-colors duration-150 hover:border-signal/60"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-panel)] bg-signal/15">
          <Users className="size-4 text-signal" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-signal">X community found</span>
          <span className="tabular block truncate text-[11px] text-chalk-faint">
            {url.replace(/^https:\/\//, '')}
          </span>
        </span>
      </span>
      <ExternalLink
        className="size-4 shrink-0 text-signal-dim transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </a>
  );
}
 
const LINK_COPY: Record<string, { label: string; icon: typeof Link2; hint: string }> = {
  profile: {
    label: 'X profile',
    icon: Link2,
    hint: 'No community group — the token links a profile instead.',
  },
  post: {
    label: 'X post',
    icon: MessageSquare,
    hint: 'No community group — the token links a single post instead.',
  },
  search: {
    label: 'X search',
    icon: Search,
    hint: 'No community group — the token links a search query instead.',
  },
  unknown: {
    label: 'X link',
    icon: Link2,
    hint: 'No community group — this X link could not be classified.',
  },
};
 
/**
 * Fallback when no community group exists: show whatever X link the token
 * carries and say plainly that it is not a community.
 */
export function XLinkNote({
  kind,
  url,
  ref,
}: {
  kind: string | null;
  url: string | null;
  ref?: string | null;
}) {
  if (!url) {
    return (
      <p className="rounded-[var(--radius-card)] border border-dashed border-ink-600 px-4 py-3 text-xs text-chalk-faint">
        This token has no X link at all in its pump.fun metadata, so there is no community group to
        find.
      </p>
    );
  }
 
  const copy = LINK_COPY[kind ?? 'unknown'] ?? LINK_COPY.unknown;
  const Icon = copy.icon;
 
  return (
    <div className="rounded-[var(--radius-card)] border border-ink-600 px-4 py-3">
      <p className="text-xs text-chalk-faint">{copy.hint}</p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="group mt-2.5 flex items-center gap-2 text-sm text-chalk-dim transition-colors duration-150 hover:text-chalk"
      >
        <Icon className="size-4 shrink-0 text-chalk-faint" aria-hidden="true" />
        <span className="tabular min-w-0 truncate">
          {ref ? `@${ref}` : url.replace(/^https:\/\//, '')}
        </span>
        <ExternalLink
          className="size-3.5 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          aria-hidden="true"
        />
      </a>
    </div>
  );
}
