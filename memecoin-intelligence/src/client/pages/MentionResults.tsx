import { useQuery } from '@tanstack/react-query';
import { apiQuery } from '@/client/lib/api';
import {
  AlertTriangle,
  BadgeCheck,
  ExternalLink,
  KeyRound,
  SearchX,
  Users,
} from 'lucide-react';
import { cn } from '@/client/lib/utils';

type Author = {
  handle: string;
  name: string;
  profileUrl: string;
  avatarUrl: string | null;
  followers: number;
  posts: number;
  isVerified: boolean;
};

type Mention = {
  id: string;
  url: string;
  text: string;
  createdAt: string | null;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  author: Author;
};

type TopAuthor = Author & {
  mentionCount: number;
  engagement: number;
};

type CascadeStep = {
  label: string;
  query: string;
  searchUrl: string;
  total: number;
  truncated: boolean;
  mentions: Mention[];
  topAuthors: TopAuthor[];
};

type SearchResult =
  | { status: 'no_key' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      address: string;
      symbol: string | null;
      steps: CascadeStep[];
      communityLinks: { url: string; id: string; postedBy: string; postUrl: string }[];
    };

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function formatAge(value: string | null) {
  if (!value) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

export default function MentionResults({ address, symbol }: { address: string; symbol: string }) {
  const { data, isFetching, error } = useQuery({
    ...apiQuery<SearchResult>('xanalysis.searchMentions', { address, symbol }),
    enabled: Boolean(address),
    staleTime: 60_000,
  });

  if (isFetching && !data) return <SkeletonPanel />;
  if (error) {
    return (
      <Shell>
        <Banner tone="ember" icon={<AlertTriangle className="size-4" />}>
          Mention search failed: {(error as Error).message}
        </Banner>
      </Shell>
    );
  }
  if (!data) return null;
  if (data.status === 'no_key') {
    return (
      <Shell>
        <Banner tone="amber" icon={<KeyRound className="size-4" />}>
          Mention search needs an API key. Set <span className="tabular">TWITTERAPI_IO_KEY</span> and retry.
        </Banner>
      </Shell>
    );
  }
  if (data.status === 'error') {
    return (
      <Shell>
        <Banner tone="ember" icon={<AlertTriangle className="size-4" />}>
          {data.message}
        </Banner>
      </Shell>
    );
  }

  return (
    <Shell busy={isFetching}>
      {data.communityLinks.length > 0 && (
        <div className="space-y-2 border-b border-ink-700 px-5 py-4">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-signal">
            <Users className="size-3.5" aria-hidden="true" />
            Community links found in posts
          </div>
          {data.communityLinks.map((link) => (
            <a
              key={link.id}
              href={link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-signal/30 bg-signal-glow px-4 py-2.5"
            >
              <span className="min-w-0">
                <span className="tabular block truncate text-xs text-signal">{link.url.replace(/^https:\/\//, '')}</span>
                <span className="block text-[11px] text-chalk-faint">shared by @{link.postedBy}</span>
              </span>
              <ExternalLink className="size-4 shrink-0 text-signal-dim" aria-hidden="true" />
            </a>
          ))}
        </div>
      )}

      {data.steps.map((step) => (
        <section key={step.query} className="border-b border-ink-700 last:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="tabular text-sm font-semibold text-chalk">{step.total}{step.truncated ? '+' : ''}</span>
                <span className="text-sm font-medium text-chalk">{step.label}</span>
              </div>
              <div className="tabular mt-1 truncate text-[11px] text-chalk-faint">{step.query}</div>
            </div>
            <a href={step.searchUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[11px] text-chalk-faint hover:text-chalk-dim">
              open in X <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </div>

          <div className="space-y-4 px-5 pb-5">
            {step.topAuthors.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {step.topAuthors.slice(0, 12).map((author) => (
                  <li key={author.handle}>
                    <a href={author.profileUrl} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2 rounded-[var(--radius-card)] border border-ink-600 bg-ink-700/50 px-2.5 py-1.5">
                      <Avatar url={author.avatarUrl} handle={author.handle} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1 text-xs text-chalk">
                          @{author.handle}
                          {author.isVerified && <BadgeCheck className="size-3 text-signal" aria-hidden="true" />}
                        </span>
                        <span className="tabular block text-[10px] text-chalk-faint">{compact.format(author.followers)} followers{author.mentionCount > 1 ? ` · ${author.mentionCount} posts` : ''}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {step.total === 0 ? (
              <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-ink-600 px-4 py-4 text-xs text-chalk-faint">
                <SearchX className="size-4" aria-hidden="true" />
                No posts matched this query in the indexed window.
              </div>
            ) : (
              <ul className="space-y-2">
                {step.mentions.slice(0, 20).map((mention) => (
                  <li key={mention.id} className="rounded-[var(--radius-card)] border border-ink-600 bg-ink-700/30 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <a href={mention.author.profileUrl} target="_blank" rel="noreferrer noopener" className="flex min-w-0 items-center gap-2.5">
                        <Avatar url={mention.author.avatarUrl} handle={mention.author.handle} size="md" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 text-sm font-medium text-chalk">
                            {mention.author.name}
                            {mention.author.isVerified && <BadgeCheck className="size-3.5 text-signal" aria-hidden="true" />}
                          </span>
                          <span className="tabular block truncate text-[11px] text-chalk-faint">@{mention.author.handle} · {compact.format(mention.author.followers)} followers</span>
                        </span>
                      </a>
                      <a href={mention.url} target="_blank" rel="noreferrer noopener" className="tabular shrink-0 text-[11px] text-chalk-faint">{formatAge(mention.createdAt)}</a>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-chalk-dim">{mention.text}</p>
                    <div className="tabular mt-3 flex flex-wrap gap-4 text-[11px] text-chalk-faint">
                      <span>{compact.format(mention.likes)} likes</span>
                      <span>{compact.format(mention.retweets)} reposts</span>
                      <span>{compact.format(mention.replies)} replies</span>
                      {mention.views > 0 && <span>{compact.format(mention.views)} views</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ))}
    </Shell>
  );
}

function Avatar({ url, handle, size = 'sm' }: { url: string | null; handle: string; size?: 'sm' | 'md' }) {
  const dimension = size === 'md' ? 'size-8' : 'size-6';
  if (!url) {
    return <span className={cn(dimension, 'flex shrink-0 items-center justify-center rounded-full bg-ink-600 text-[10px] font-semibold uppercase text-chalk-faint')} aria-hidden="true">{handle.slice(0, 2)}</span>;
  }
  return <img src={url} alt="" loading="lazy" className={cn(dimension, 'shrink-0 rounded-full border border-ink-600 object-cover')} />;
}

function Shell({ children, busy = false }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <section className={cn('animate-slide-up overflow-hidden rounded-[var(--radius-card)] border border-ink-600 bg-ink-800 transition-opacity duration-200', busy && 'opacity-60')}>
      <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
        <h2 className="text-sm font-semibold text-chalk">X mentions</h2>
        <span className="text-[11px] uppercase tracking-[0.18em] text-chalk-faint">address → ticker</span>
      </div>
      {children}
    </section>
  );
}

function SkeletonPanel() {
  return (
    <Shell>
      <div className="space-y-3 p-5">
        {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-[var(--radius-card)] bg-ink-700" />)}
      </div>
    </Shell>
  );
}

function Banner({ tone, icon, children }: { tone: 'amber' | 'ember'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-5 py-4 text-xs leading-relaxed text-chalk-dim">
      <span className={cn('mt-0.5 shrink-0', tone === 'amber' ? 'text-amber' : 'text-ember')}>{icon}</span>
      <p>{children}</p>
    </div>
  );
}
