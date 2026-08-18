declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe: {
          user?: { id: number; username?: string; first_name?: string; last_name?: string };
        };
        ready: () => void;
        expand: () => void;
        close: () => void;
        openLink: (url: string) => void;
        sendData: (data: string) => void;
        onEvent?: (eventType: string, eventHandler: (...args: any[]) => void) => void;
        offEvent?: (eventType: string, eventHandler: (...args: any[]) => void) => void;
        HapticFeedback?: {
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
        };
        colorScheme: 'light' | 'dark';
        themeParams: Record<string, string>;
        viewportHeight: number;
        viewportStableHeight: number;
      };
    };
  }
}

const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;

export function initTelegram() {
  tg?.ready();
  tg?.expand();
  return tg ?? null;
}

export function getTelegramUser() {
  return tg?.initDataUnsafe?.user || null;
}

export function getTelegramInitData() {
  return tg?.initData || '';
}

export function openExternalLink(url: string) {
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export function sendData(data: unknown) {
  return tg ? (window.Telegram?.WebApp as any)?.sendData?.(JSON.stringify(data)) : undefined;
}

export function showSuccess(message: string) {
  tg?.HapticFeedback?.notificationOccurred('success');
  window.Telegram?.WebApp?.sendData?.(JSON.stringify({ type: 'toast', level: 'success', message }));
}

export function showError(message: string) {
  tg?.HapticFeedback?.notificationOccurred('error');
  window.Telegram?.WebApp?.sendData?.(JSON.stringify({ type: 'toast', level: 'error', message }));
}

export async function copyToClipboard(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
