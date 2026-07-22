export type ActionPayload =
  | { action: 'payment'; amount_usdt: number; network: string }
  | { action: 'access'; password: string }
  | { action: 'watchlist'; symbol: string; note?: string }
  | { action: 'create'; title: string; description: string };

export const sendToBot = (sendData: (d: any) => void, payload: ActionPayload) => {
  sendData(payload);
};
