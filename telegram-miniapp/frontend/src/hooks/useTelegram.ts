import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

export const useTelegram = () => {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const webapp = window.Telegram?.WebApp;
    if (!webapp) return;

    webapp.ready();
    webapp.expand();
    setTheme(webapp.colorScheme || 'dark');

    const handleTheme = () => setTheme(webapp.colorScheme || 'dark');
    (webapp as any).onEvent?.('themeChanged', handleTheme);
    return () => (webapp as any).offEvent?.('themeChanged', handleTheme);
  }, []);

  const sendData = (data: unknown) => window.Telegram?.WebApp?.sendData(JSON.stringify(data));
  const hapticNotify = (type: 'error' | 'success' | 'warning') => window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(type);

  return { theme, sendData, hapticNotify };
};
