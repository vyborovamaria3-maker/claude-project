export type MiniappAction =
  | { action: "payment"; amount_usdt: number; network: string }
  | { action: "access"; password: string }
  | { action: "watchlist"; symbol: string; note?: string }
  | { action: "create"; title: string; description: string };

export function sendToBot(
  sendData: (data: Record<string, unknown>) => void,
  payload: MiniappAction
) {
  sendData(payload as unknown as Record<string, unknown>);
}

export function validatePassword(password: string): string | null {
  if (!password || password.length < 6) return "Минимум 6 символов";
  return null;
}

export function validateSymbol(symbol: string): string | null {
  if (!symbol || symbol.trim().length === 0) return "Введите тикер";
  return null;
}
