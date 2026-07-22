import { useEffect, useState } from 'react';

declare global {
  interface Window {
    Telegram: any;
  }
}

export const useTelegram = () => {
  const [tg, setTg] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const webapp = window.Telegram?.WebApp;
    if (!webapp) return;
    webapp.ready();
    webapp.expand();
    setTg(webapp);
    setUser(webapp.initDataUnsafe?.user);
    setTheme(webapp.colorScheme);
    webapp.onEvent('themeChanged', () => setTheme(webapp.colorScheme));
    return () => webapp.offEvent('themeChanged');
  }, []);

  const sendData = (data: any) => tg?.sendData(JSON.stringify(data));
  const hapticImpact = (style: 'light' | 'medium' | 'heavy' = 'medium') => tg?.HapticFeedback?.impactOccurred(style);
  const hapticNotify = (type: 'error' | 'success' | 'warning') => tg?.HapticFeedback?.notificationOccurred(type);

  return { tg, user, theme, sendData, hapticImpact, hapticNotify };
};
