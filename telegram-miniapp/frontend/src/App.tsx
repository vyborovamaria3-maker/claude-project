import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldCheck, Sparkles, Copy, Check, Zap, CircleDollarSign } from 'lucide-react';
import { useTelegram } from './hooks/useTelegram';
import { initTelegram, getTelegramUser, copyToClipboard, openExternalLink } from './lib/telegram';

const API_BASE_URL = import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? window.location.origin : '');

type AccessPayload = {
  login?: string | null;
  password?: string | null;
  subscriptionExpiresAt?: string | null;
  paymentUrl?: string | null;
  currency?: 'SOL' | 'USDT' | 'DEMO';
};

const methods = ['SOL', 'USDT', 'DEMO'] as const;

function PlasmaSweep({ active }: { active: boolean }) {
  return <div className={`plasma-sweep ${active ? 'plasma-sweep--active' : ''}`} aria-hidden="true" />;
}

function CopyButton({
  value,
  label,
  copied,
  onCopy,
}: {
  value: string | null | undefined;
  label: string;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!value) return null;
  return (
    <button type="button" className="copy-btn" onClick={onCopy} aria-label={`Copy ${label}`}>
      <span>{copied ? '✓ COPIED' : 'COPY'}</span>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export default function App() {
  const { theme, hapticNotify, sendData } = useTelegram();
  const user = getTelegramUser();
  const [method, setMethod] = useState<(typeof methods)[number]>('SOL');
  const [loading, setLoading] = useState(false);
  const [sweep, setSweep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Connected to Telegram WebApp.');
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [checkoutPayload, setCheckoutPayload] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ login: boolean; password: boolean }>({ login: false, password: false });
  const hasFullAccess = Boolean(access?.login && access?.password);

  useEffect(() => {
    initTelegram();
  }, []);

  const userLabel = useMemo(() => user?.first_name || user?.username || 'Trader', [user]);

  useEffect(() => {
    if (!checkoutPayload || hasFullAccess) return;
    const timer = window.setInterval(() => {
      void verifyPayment(checkoutPayload, false);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [checkoutPayload, hasFullAccess]);

  async function createAccess() {
    setLoading(true);
    setError(null);
    setStatus(`Creating ${method} access...`);
    try {
      const response = await fetch(`${API_BASE_URL}/api/miniapp/create-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: window.Telegram?.WebApp?.initData || '', method, login: user?.username || `tg_${user?.id ?? 'user'}` }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Failed to create access');

      if (data?.paymentUrl) {
        openExternalLink(data.paymentUrl);
      }

      if (data?.payload) {
        setCheckoutPayload(data.payload);
      }

      setAccess({
        login: data.login,
        password: data.password,
        subscriptionExpiresAt: data.subscriptionExpiresAt,
        paymentUrl: data.paymentUrl,
        currency: method,
      });

      setStatus(data.password ? 'Access credentials received.' : 'Payment initiated. Waiting for credentials...');
      hapticNotify('success');
      sendData?.({ action: 'payment_initiated', method, payload: data.payload || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start checkout');
      setStatus('Checkout failed.');
      hapticNotify('error');
    } finally {
      setLoading(false);
    }
  }

  async function verifyPayment(payload: string, showPending: boolean) {
    if (!payload || hasFullAccess) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/miniapp/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: window.Telegram?.WebApp?.initData || '', payload }),
      });
      const data = await response.json();
      if (response.status === 202 || data?.status === 'pending') {
        if (showPending) setStatus('Transaction is pending. We keep checking…');
        return;
      }
      if (!response.ok) throw new Error(data?.error || 'Failed to verify payment');
      if (data?.status !== 'paid' || !data?.login || !data?.password) throw new Error('Incomplete paid response');

      setAccess({
        login: data.login,
        password: data.password,
        subscriptionExpiresAt: data.subscriptionExpiresAt,
        paymentUrl: data.paymentUrl || access?.paymentUrl,
        currency: data.currency || method,
      });
      setCheckoutPayload(null);
      setStatus('Access credentials received.');
      hapticNotify('success');
    } catch (err) {
      if (showPending) {
        setError(err instanceof Error ? err.message : 'Unable to verify payment');
        hapticNotify('error');
      }
    }
  }

  async function handleCopy(key: 'login' | 'password', value: string) {
    const ok = await copyToClipboard(value);
    if (!ok) {
      setError('Clipboard is unavailable in this webview.');
      return;
    }
    setCopied((prev) => ({ ...prev, [key]: true }));
    setSweep(true);
    hapticNotify('success');
    window.setTimeout(() => {
      setCopied((prev) => ({ ...prev, [key]: false }));
      setSweep(false);
    }, 3000);
  }

  return (
    <div className={`miniapp-shell ${theme === 'dark' ? 'miniapp-shell--dark' : ''}`}>
      <PlasmaSweep active={sweep} />
      <main className="miniapp-page">
        <section className="hero-card">
          <div className="hero-top">
            <div className="eyebrow"><Sparkles size={14} /> Hologram Pro</div>
            <div className="status-pill"><ShieldCheck size={14} /> Telegram-safe</div>
          </div>
          <h1>POTAPoff access for {userLabel}</h1>
          <p>{access ? 'Credentials are ready. Copy only real values received from backend.' : 'Choose SOL, USDT, or demo. The same design language powers the main site and Mini App.'}</p>
          <div className="method-row">
            {methods.map((item) => (
              <button key={item} type="button" className={`method-chip ${method === item ? 'is-active' : ''}`} onClick={() => setMethod(item)}>
                <CircleDollarSign size={14} /> {item}
              </button>
            ))}
          </div>
          <button className="primary-btn" type="button" onClick={createAccess} disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <Zap size={16} />}
            <span>{loading ? 'Creating...' : 'Unlock access'}</span>
          </button>
        </section>

        <section className="grid-card">
          <div className="info-card">
            <div>
              <div className="section-label">Access payload</div>
              <h2>Real credentials only</h2>
            </div>
            <div className="access-grid">
              <div className="kv">
                <span>Login</span>
                <strong>{access?.login || 'Pending backend response'}</strong>
                {hasFullAccess ? <CopyButton value={access?.login} label="login" copied={copied.login} onCopy={() => access?.login && void handleCopy('login', access.login)} /> : null}
              </div>
              <div className="kv">
                <span>Password</span>
                <strong>{access?.password ? 'Received' : 'Pending backend response'}</strong>
                {hasFullAccess ? <CopyButton value={access?.password} label="password" copied={copied.password} onCopy={() => access?.password && void handleCopy('password', access.password)} /> : null}
              </div>
            </div>
            <div className="note-row">
              <span>{access?.subscriptionExpiresAt ? `Valid until ${new Date(access.subscriptionExpiresAt).toLocaleString()}` : 'Waiting for backend confirmation'}</span>
              {access?.paymentUrl ? <button type="button" className="link-btn" onClick={() => openExternalLink(access.paymentUrl!)}>Open payment</button> : null}
            </div>
          </div>

          <div className="info-card">
            <div className="section-label">Live status</div>
            <div className="status-box">{status}</div>
            <div className="status-box status-box--muted">
              Subscription flow, initData verification, and payment semantics stay server-side. Mini App only renders real state.
            </div>
            {error && <div className="error-box">{error}</div>}
          </div>
        </section>
      </main>
    </div>
  );
}
