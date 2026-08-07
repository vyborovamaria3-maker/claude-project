/**
 * Page wrapper template to be used as a base for all pages.
 */
 
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Radar } from 'lucide-react';
import LoadingSpinner from '@/client/components/LoadingSpinner';
import { Seo, type SeoProps } from '@/client/components/Seo';
import { Button } from '@/client/components/ui/Button';
import { cn } from '@/client/lib/utils';
 
interface PageProps {
  children?: React.ReactNode;
  isLoading?: boolean;
  className?: string;
  /** Per-page <head> overrides (title, description, OG image, etc). */
  seo?: SeoProps;
}
 
const NAV_ITEMS = [
  { label: 'X Analysis', to: '/' },
];
 
function Header() {
  const { pathname } = useLocation();
 
  return (
    <header className="sticky top-0 z-40 border-b border-ink-600 bg-ink-850/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Link
            to="/"
            className="group flex items-center gap-2.5 transition-opacity duration-150 hover:opacity-80"
          >
            <span className="flex size-7 items-center justify-center rounded-[var(--radius-panel)] bg-signal-glow">
              <Radar className="size-4 text-signal" aria-hidden="true" />
            </span>
            <span className="font-display text-[15px] font-semibold tracking-tight text-chalk">
              Signal Room
            </span>
          </Link>
 
          <nav className="hidden items-center gap-1 sm:flex">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'rounded-[var(--radius-panel)] px-3 py-1.5 text-[13px] font-medium transition-colors duration-150',
                    isActive
                      ? 'bg-ink-700 text-chalk'
                      : 'text-chalk-faint hover:bg-ink-800 hover:text-chalk-dim'
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
 
        <div className="tabular text-xs text-chalk-faint">standalone v3</div>
      </div>
    </header>
  );
}
 
function PageWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid-backdrop flex min-h-screen max-w-full flex-col overflow-x-hidden bg-ink-900">
      {children}
    </div>
  );
}
 
function PageBody({ children, className, isLoading = false }: PageProps) {
  return (
    <div className="flex w-full min-h-0 flex-1">
      <main
        className={cn(
          'mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 overflow-x-hidden px-6 py-8',
          className
        )}
      >
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center">
            <LoadingSpinner />
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
 
export default function Page({ children, className, isLoading = false, seo }: PageProps) {
  return (
    <PageWrapper>
      <Seo {...seo} />
      <Header />
      <PageBody className={className} isLoading={isLoading}>
        {children}
      </PageBody>
    </PageWrapper>
  );
}