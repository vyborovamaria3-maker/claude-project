import crypto from 'node:crypto';
import { config } from '../config';

export type TelegramInitUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

const MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const HASH_RE = /^[0-9a-fA-F]{64}$/;

export class TelegramAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramAuthError';
  }
}

export function verifyTelegramInitData(initData: string): TelegramInitUser {
  if (!initData || !config.telegramBotToken) {
    throw new TelegramAuthError('Telegram initData is required');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !HASH_RE.test(hash)) {
    throw new TelegramAuthError('Telegram initData hash is invalid');
  }

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(config.telegramBotToken)
    .digest();
  const calculated = crypto
    .createHmac('sha256', secret)
    .update(dataCheckString)
    .digest();
  const received = Buffer.from(hash, 'hex');

  if (received.length !== calculated.length || !crypto.timingSafeEqual(received, calculated)) {
    throw new TelegramAuthError('Telegram initData signature is invalid');
  }

  const authDate = Number(params.get('auth_date') || '0');
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate <= 0 ||
    authDate < now - MAX_AGE_SECONDS ||
    authDate > now + MAX_FUTURE_SKEW_SECONDS
  ) {
    throw new TelegramAuthError('Telegram initData is expired or invalid');
  }

  const rawUser = params.get('user');
  if (!rawUser) {
    throw new TelegramAuthError('Telegram initData user is missing');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    throw new TelegramAuthError('Telegram initData user is invalid');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new TelegramAuthError('Telegram initData user is invalid');
  }

  const user = parsed as Partial<TelegramInitUser>;
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) {
    throw new TelegramAuthError('Telegram initData user id is invalid');
  }

  return user as TelegramInitUser;
}
