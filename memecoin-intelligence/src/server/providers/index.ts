import { env } from '@/server/config/env.js';
import { FixtureProvider } from './fixture.js';
import { TwitterApiIoProvider } from './twitterapi.js';
import type { SocialDataProvider } from './types.js';

export function getProvider(): SocialDataProvider {
  if (env.DATA_PROVIDER === 'twitterapi') return new TwitterApiIoProvider();
  if (env.DATA_PROVIDER === 'x-api') {
    throw new Error('The official X API adapter is intentionally disabled until an API credit balance is configured. Use fixture mode for free testing.');
  }
  return new FixtureProvider();
}
