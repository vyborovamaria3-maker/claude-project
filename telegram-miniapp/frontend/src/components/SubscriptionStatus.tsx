import { Crown, Calendar, Loader2 } from 'lucide-react';

interface SubscriptionStatusProps {
  active: boolean;
  subscriptionEnd: Date | null;
  loading: boolean;
}

export function SubscriptionStatus({ active, subscriptionEnd, loading }: SubscriptionStatusProps) {
  if (loading) {
    return (
      <div className="glass-panel rounded-3xl px-4 py-4 text-sm text-white/70">
        <div className="flex items-center justify-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Checking subscription...</span>
        </div>
      </div>
    );
  }

  if (!active) {
    return null;
  }

  const formatDate = (date: Date) => date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const daysLeft = subscriptionEnd
    ? Math.ceil((subscriptionEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

  return (
    <div className="glass-panel rounded-3xl p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-emerald-400/15 ring-1 ring-emerald-300/20">
          <Crown className="h-5 w-5 text-emerald-300" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-emerald-200">Premium active</h3>
          <p className="text-sm text-white/65">{daysLeft} days remaining</p>
        </div>
      </div>

      {subscriptionEnd && (
        <div className="mt-3 flex items-center gap-2 text-sm text-white/65">
          <Calendar className="h-4 w-4" />
          <span>Valid until {formatDate(subscriptionEnd)}</span>
        </div>
      )}
    </div>
  );
}
