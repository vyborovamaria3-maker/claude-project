/**
 * Telegram WebApp SDK integration
 */

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe: {
          user?: {
            id: number;
            username?: string;
            first_name?: string;
            last_name?: string;
          };
          start_param?: string;
        };
        ready: () => void;
        expand: () => void;
        close: () => void;
        openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
        showPopup: (params: { title?: string; message: string; buttons?: Array<{ id: string; type: string; text: string }> }) => void;
        showAlert: (message: string) => void;
        showConfirm: (message: string, callback: (confirmed: boolean) => void) => void;
        enableClosingConfirmation: () => void;
        disableClosingConfirmation: () => void;
        setHeaderColor: (color: string) => void;
        setBackgroundColor: (color: string) => void;
        MainButton: {
          text: string;
          color: string;
          textColor: string;
          isVisible: boolean;
          isActive: boolean;
          setText: (text: string) => void;
          onClick: (callback: () => void) => void;
          show: () => void;
          hide: () => void;
          enable: () => void;
          disable: () => void;
          setParams: (params: { text?: string; color?: string; text_color?: string }) => void;
        };
        BackButton: {
          isVisible: boolean;
          onClick: (callback: () => void) => void;
          show: () => void;
          hide: () => void;
        };
        HapticFeedback: {
          impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
          selectionChanged: () => void;
        };
        platform: string;
        version: string;
        colorScheme: 'light' | 'dark';
        themeParams: {
          bg_color: string;
          text_color: string;
          hint_color: string;
          link_color: string;
          button_color: string;
          button_text_color: string;
        };
        isExpanded: boolean;
        viewportHeight: number;
        viewportStableHeight: number;
      };
    };
  }
}

const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;

export { tg };

/**
 * Initialize Telegram WebApp
 */
export function initTelegram() {
  if (!tg) {
    console.warn('Telegram WebApp not available');
    return null;
  }
  
  tg.ready();
  tg.expand();
  
  return tg;
}

/**
 * Get Telegram user data
 */
export function getTelegramUser() {
  return tg?.initDataUnsafe?.user || null;
}

/**
 * Open external link (e.g., Solana Pay URL)
 */
export function openExternalLink(url: string) {
  if (tg?.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, '_blank');
  }
}

/**
 * Show success notification
 */
export function showSuccess(message: string) {
  if (tg?.HapticFeedback) {
    tg.HapticFeedback.notificationOccurred('success');
  }
  if (tg?.showPopup) {
    tg.showPopup({ title: 'Success', message });
  } else {
    alert(message);
  }
}

/**
 * Show error notification
 */
export function showError(message: string) {
  if (tg?.HapticFeedback) {
    tg.HapticFeedback.notificationOccurred('error');
  }
  if (tg?.showPopup) {
    tg.showPopup({ title: 'Error', message });
  } else {
    alert(message);
  }
}

/**
 * Set main button parameters
 */
export function setMainButton(params: {
  text: string;
  color?: string;
  text_color?: string;
  onClick?: () => void;
}) {
  if (!tg?.MainButton) return;
  
  tg.MainButton.setParams({
    text: params.text,
    color: params.color,
    text_color: params.text_color,
  });
  
  if (params.onClick) {
    tg.MainButton.onClick(params.onClick);
  }
  
  tg.MainButton.show();
}

/**
 * Hide main button
 */
export function hideMainButton() {
  tg?.MainButton?.hide();
}
