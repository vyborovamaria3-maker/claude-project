import type { SocialDataProvider } from './types.js';
import { env } from '@/server/config/env.js';
import { searchX } from '@/server/xanalysis/xsearch.js';

export class TwitterApiIoProvider implements SocialDataProvider {
  readonly name = 'twitterapi.io';
  isConfigured() { return Boolean(env.TWITTERAPI_IO_KEY); }
  async search(query: string) {
    const result = await searchX(query, { queryType: 'Latest', pages: env.SEARCH_PAGES });
    return { ...result, provider: this.name };
  }
}
