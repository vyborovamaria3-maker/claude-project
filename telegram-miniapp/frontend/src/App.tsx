import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  BarChart3,
  Check,
  Clock3,
  Eye,
  Grid2X2,
  Layers3,
  Lock,
  ListPlus,
  Sparkles,
  Wallet,
  Zap,
  Crown,
  ShieldCheck,
  SignalHigh,
  PanelTopOpen,
} from 'lucide-react';

import { paymentSchema, accessSchema, watchlistSchema } from './utils/validation';
import { sendToBot } from './utils/api';
import { useTelegram } from './hooks/useTelegram';
import { useSubscription } from './hooks/useSubscription';
import { initTelegram, getTelegramUser } from './lib/telegram';
import { Button } from './components/UI/Button';
import { Card } from './components/UI/Card';
import { Input } from './components/UI/Input';
import { PayButton } from './components/PayButton';
import { SubscriptionStatus } from './components/SubscriptionStatus';

type PaymentForm = { network: string };
type AccessForm = { password: string };
type WatchlistForm = { symbol: string; note?: string };
type TabKey = 'overview' | 'access' | 'watchlist' | 'swap';

const networks = ['Solana', 'Ethereum', 'BSC', 'Base', 'Arbitrum', 'Optimism'];

const tabs: Array<{
  key: TabKey;
  label: string;
  icon: typeof Sparkles;
}> = [
  { key: 'overview', label: 'Overview', icon: Sparkles },
  { key: 'access', label: 'Access', icon: Lock },
  { key: 'watchlist', label: 'Watchlist', icon: ListPlus },
  { key: 'swap', label: 'Swap', icon: Eye },
];

function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: typeof ShieldCheck;
  label: string;
  value: string;
  tone?: 'neutral' | 'blue' | 'purple' | 'green' | 'gold';
}) {
  const toneClass: Record<string, string> = {
    neutral: 'from-white/8 to-white/4 border-white/10',
    blue: 'from-sky-500/15 to-cyan-500/10 border-sky-400/20',
    purple: 'from-violet-500/15 to-fuchsia-500/10 border-violet-400/20',
    green: 'from-emerald-500/15 to-lime-500/10 border-emerald-400/20',
    gold: 'from-amber-400/20 to-orange-500/10 border-amber-300/30',
  };

  return (
    <div className={`rounded-2xl border bg-gradient-to-br ${toneClass[tone]} p-4 shadow-[0_16px_60px_rgba(0,0,0,0.18)]`}>
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-black/20 ring-1 ring-white/10">
          <Icon size={18} className="text-white/90" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.22em] text-white/55">{label}</p>
          <p className="truncate text-base font-semibold text-white">{value}</p>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-white/45">{eyebrow}</span>
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="text-sm leading-6 text-white/70">{description}</p>
    </div>
  );
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof Sparkles;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all ${
        active
          ? 'bg-white text-slate-950 shadow-[0_8px_32px_rgba(255,255,255,0.18)]'
          : 'bg-white/6 text-white/72 ring-1 ring-white/10 hover:bg-white/10 hover:text-white'
      }`}
    >
      <Icon size={15} className={active ? 'text-slate-950' : 'text-white/80'} />
      <span>{label}</span>
    </button>
  );
}

export default function App() {
  const { theme, sendData, hapticNotify } = useTelegram();
  const { active, loading, subscriptionEnd, refresh } = useSubscription();
  const user = getTelegramUser();
  const [tab, setTab] = useState<TabKey>('overview');
  const [status, setStatus] = useState('Ready to connect and trade.');

  useEffect(() => {
    initTelegram();
  }, []);

  const paymentForm = useForm<PaymentForm>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { network: networks[0] },
  });
  const accessForm = useForm<AccessForm>({ resolver: zodResolver(accessSchema) });
  const watchForm = useForm<WatchlistForm>({ resolver: zodResolver(watchlistSchema) });

  const marketSnapshot = useMemo(
    () => [
      { icon: BarChart3, label: 'Pairs scanned', value: '1,284', tone: 'blue' as const },
      { icon: SignalHigh, label: 'Momentum', value: 'Hot', tone: 'purple' as const },
      { icon: ShieldCheck, label: 'Safety check', value: 'Active', tone: 'green' as const },
      { icon: Clock3, label: 'Refresh', value: 'Live', tone: 'gold' as const },
    ],
    [],
  );

  const onPay = paymentForm.handleSubmit((data) => {
    sendToBot(sendData, { action: 'payment', amount_usdt: 1000, network: data.network });
    setStatus(`Payment sent for 1000 USDT on ${data.network}.`);
    hapticNotify('success');
  });

  const onAccess = accessForm.handleSubmit((data) => {
    sendToBot(sendData, { action: 'access', password: data.password });
    setStatus('Password saved and sent to the bot.');
    hapticNotify('success');
  });

  const onWatchlist = watchForm.handleSubmit((data) => {
    sendToBot(sendData, { action: 'watchlist', symbol: data.symbol, note: data.note });
    setStatus(`${data.symbol.toUpperCase()} added to watchlist.`);
    hapticNotify('success');
    watchForm.reset();
  });

  const activeUserLabel = user?.first_name || user?.username || 'Trader';

  return (
    <div className={`${theme === 'dark' ? 'dark' : ''} app-shell min-h-screen overflow-x-hidden text-white`}>
      <div className="app-bg" />
      <main className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-5 lg:px-6">
        <header className="glass-panel sticky top-3 z-20 rounded-3xl p-4 backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-cyan-400 via-sky-500 to-indigo-500 shadow-[0_20px_60px_rgba(56,189,248,0.35)]">
                <Layers3 size={22} className="text-white" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/45">
                  Premium Terminal
                </p>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  Swap Access
                </h1>
                <p className="mt-1 text-sm text-white/65">
                  Modular watchlists, quick actions, and cleaner token workflows.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {tabs.map((item) => (
                <TabButton
                  key={item.key}
                  active={tab === item.key}
                  icon={item.icon}
                  label={item.label}
                  onClick={() => setTab(item.key)}
                />
              ))}
            </div>
          </div>
        </header>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-panel rounded-3xl px-4 py-3 text-sm text-white/80 backdrop-blur-xl"
        >
          {status}
        </motion.div>

        <SubscriptionStatus active={active} subscriptionEnd={subscriptionEnd} loading={loading} />

        {tab === 'overview' && (
          <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <motion.section
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-panel overflow-hidden rounded-[28px] p-5"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/8 via-transparent to-fuchsia-500/8" />
              <div className="relative flex flex-col gap-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="max-w-xl">
                    <SectionHeader
                      eyebrow="Overview"
                      title={active ? 'Premium active' : 'Unlock the terminal'}
                      description={
                        active
                          ? `Welcome back, ${activeUserLabel}. Your subscription is active and the dashboard is ready.`
                          : 'A compact terminal for subscriptions, watchlists, and fast swap previews.'
                      }
                    />
                  </div>
                  <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-white/70">
                    {active ? 'Live' : 'Preview'}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {marketSnapshot.map((item) => (
                    <StatCard
                      key={item.label}
                      icon={item.icon}
                      label={item.label}
                      value={item.value}
                      tone={item.tone}
                    />
                  ))}
                </div>

                <div className="grid gap-3 rounded-[24px] border border-white/10 bg-black/15 p-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <p className="text-xs uppercase tracking-[0.22em] text-white/45">Flow</p>
                    <p className="text-lg font-semibold">Keep blocks editable and shallow</p>
                    <p className="text-sm leading-6 text-white/68">
                      Each tab is isolated, and each section can be tuned independently without touching the rest.
                    </p>
                  </div>
                  <div className="flex items-center justify-between rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
                    <div>
                      <p className="text-xs uppercase tracking-[0.22em] text-white/45">Action</p>
                      <p className="mt-1 text-sm font-medium text-white/80">Open the flow that fits the task</p>
                    </div>
                    <ArrowRight className="text-white/60" size={20} />
                  </div>
                </div>
              </div>
            </motion.section>

            <div className="flex flex-col gap-5">
              <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-panel rounded-[28px] p-5"
              >
                <SectionHeader
                  eyebrow="Subscription"
                  title="Status"
                  description="Paywall and active subscription are separated from the rest of the UI."
                />
                <div className="mt-4">
                  {active ? (
                    <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4">
                      <div className="flex items-center gap-3">
                        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-400/15">
                          <Crown size={20} className="text-emerald-300" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-emerald-200">Premium active</p>
                          <p className="text-sm text-white/65">
                            {subscriptionEnd
                              ? `Valid until ${subscriptionEnd.toLocaleDateString()}`
                              : 'Subscription is confirmed.'}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-sm font-medium text-white/80">No active subscription yet.</p>
                      <p className="mt-1 text-sm text-white/60">
                        The payment card below is isolated so it can be redesigned independently.
                      </p>
                    </div>
                  )}
                </div>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-panel rounded-[28px] p-5"
              >
                <SectionHeader
                  eyebrow="Quick action"
                  title="Payment"
                  description="The payment surface stays separate from analysis and watchlists."
                />
                <div className="mt-4">
                  <PayButton onPaymentInitiated={refresh} />
                </div>
              </motion.section>
            </div>
          </div>
        )}

        {tab === 'access' && (
          <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
            <Card className="glass-card rounded-[28px] p-5">
              <SectionHeader
                eyebrow="Access"
                title="Password block"
                description="Credential entry stays in one isolated panel for easier future edits."
              />
              <form onSubmit={onAccess} className="mt-5 flex flex-col gap-4">
                <Input
                  label="Password"
                  type="password"
                  placeholder="Enter your secret password"
                  {...accessForm.register('password')}
                  error={accessForm.formState.errors.password?.message}
                />
                <Button type="submit">Save password</Button>
              </form>
            </Card>

            <Card className="glass-card rounded-[28px] p-5">
              <SectionHeader
                eyebrow="Notes"
                title="Access flow"
                description="After payment, the bot sends a login. This screen stores the password and forwards it."
              />
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <StatCard icon={ShieldCheck} label="Security" value="Separated" tone="green" />
                <StatCard icon={Clock3} label="UX" value="Fast input" tone="blue" />
              </div>
            </Card>
          </div>
        )}

        {tab === 'watchlist' && (
          <div className="grid gap-5 lg:grid-cols-[0.92fr_1.08fr]">
            <Card className="glass-card rounded-[28px] p-5">
              <SectionHeader
                eyebrow="Watchlist"
                title="Add a token"
                description="Each field is isolated to make future changes to validation or labels straightforward."
              />
              <form onSubmit={onWatchlist} className="mt-5 flex flex-col gap-4">
                <Input
                  label="Ticker / pair"
                  placeholder="SOL/USDT"
                  {...watchForm.register('symbol')}
                  error={watchForm.formState.errors.symbol?.message}
                />
                <Input
                  label="Note"
                  placeholder="Why this token matters"
                  {...watchForm.register('note')}
                />
                <Button type="submit">Add to watchlist</Button>
              </form>
            </Card>

            <Card className="glass-card rounded-[28px] p-5">
              <SectionHeader
                eyebrow="Watchlist blocks"
                title="Optimized for later expansion"
                description="This panel can become a list, filters, or compact alerts feed without changing the form."
              />
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <StatCard icon={Zap} label="Momentum" value="Ready" tone="gold" />
                <StatCard icon={PanelTopOpen} label="Layout" value="Modular" tone="purple" />
                <StatCard icon={Grid2X2} label="Blocks" value="Reusable" tone="blue" />
                <StatCard icon={ListPlus} label="Update path" value="Simple" tone="green" />
              </div>
            </Card>
          </div>
        )}

        {tab === 'swap' && (
          <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
            <Card className="glass-card overflow-hidden rounded-[28px] p-5">
              <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 via-transparent to-violet-500/10" />
              <div className="relative flex flex-col gap-4">
                <SectionHeader
                  eyebrow="Swap preview"
                  title="Quick market card"
                  description="This block is isolated so price data, quote routing, and buttons can evolve separately."
                />
                <div className="rounded-[24px] border border-white/10 bg-black/15 p-4">
                  <div className="flex items-center gap-3">
                    <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-500">
                      <Wallet size={22} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-lg font-semibold">Quick swap preview</p>
                      <p className="text-sm text-white/65">Indicative routing and quote layout</p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-xs uppercase tracking-[0.22em] text-white/45">Rate</p>
                      <p className="mt-2 text-2xl font-semibold">1 SOL</p>
                      <p className="text-sm text-white/65">≈ 160 USDT example</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <p className="text-xs uppercase tracking-[0.22em] text-white/45">Route</p>
                      <p className="mt-2 text-2xl font-semibold">Solana</p>
                      <p className="text-sm text-white/65">Wallet route placeholder</p>
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="glass-card rounded-[28px] p-5">
              <SectionHeader
                eyebrow="Editing"
                title="Simplified blocks"
                description="If you change one panel, the other tabs remain untouched."
              />
              <div className="mt-5 grid gap-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm font-semibold">Market data</p>
                  <p className="mt-1 text-sm text-white/65">Plug in real quotes later.</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm font-semibold">Buttons</p>
                  <p className="mt-1 text-sm text-white/65">Keep CTA styles centralized.</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-sm font-semibold">Layout</p>
                  <p className="mt-1 text-sm text-white/65">All spacing comes from one page shell.</p>
                </div>
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
