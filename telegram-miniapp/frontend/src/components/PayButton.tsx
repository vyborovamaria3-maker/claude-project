import { useState } from 'react';
import { Wallet, Loader2, CheckCircle } from 'lucide-react';
import { api } from '../lib/api';
import { openExternalLink, showError, showSuccess, getTelegramUser } from '../lib/telegram';

interface PayButtonProps {
  onPaymentInitiated?: () => void;
}

export function PayButton({ onPaymentInitiated }: PayButtonProps) {
  const [loading, setLoading] = useState(false);
  const [paymentCreated, setPaymentCreated] = useState(false);

  const handlePay = async () => {
    const user = getTelegramUser();
    if (!user) {
      showError('Please open this app from Telegram');
      return;
    }

    setLoading(true);
    try {
      const response = await api.createPayment({
        telegramId: user.id,
        username: user.username,
        plan: 'premium',
      });

      if (!response.success || !response.data) {
        showError(response.error || 'Failed to create payment');
        return;
      }

      const { payUrl } = response.data;
      setPaymentCreated(true);
      onPaymentInitiated?.();
      openExternalLink(payUrl);
      showSuccess('Please complete the payment in your wallet');
    } catch (error) {
      console.error('Payment error:', error);
      showError('Failed to initiate payment');
    } finally {
      setLoading(false);
    }
  };

  if (paymentCreated) {
    return (
      <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-center">
        <div className="flex items-center justify-center gap-2 text-emerald-200">
          <CheckCircle className="h-5 w-5" />
          <span className="text-sm font-medium">Payment initiated</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-white/65">
          Complete the payment in your wallet. Your subscription will activate automatically.
        </p>
      </div>
    );
  }

  return (
    <button
      onClick={handlePay}
      disabled={loading}
      className="group flex w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-cyan-500 via-sky-500 to-indigo-500 px-5 py-4 text-sm font-semibold text-white shadow-[0_20px_50px_rgba(56,189,248,0.28)] transition-transform hover:-translate-y-0.5 hover:shadow-[0_24px_60px_rgba(56,189,248,0.34)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Creating payment...</span>
        </>
      ) : (
        <>
          <Wallet className="h-5 w-5" />
          <span>Pay 1000 USDT</span>
        </>
      )}
    </button>
  );
}
