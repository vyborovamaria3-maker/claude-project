import type { SocialDataProvider } from './types.js';
import { env } from '@/server/config/env.js';
import { searchX } from '@/server/xanalysis/xsearch.js';

export class TwitterApiIoProvider implements SocialDataProvider {
  readonly name = 'twitterapi.io';
  isConfigured() { return Boolean(env.TWITTERAPI_IO_KEY); }
  async search(query: string, options: { limit?: number } = {}) {
    const limit = Math.max(1, Math.min(env.MAX_SEARCH_RESULTS, Math.floor(options.limit ?? env.MAX_SEARCH_RESULTS)));
    const result = await searchX(query, { queryType: 'Latest', pages: Math.min(env.SEARCH_PAGES, Math.ceil(limit / 20)) });
    return { ...result, mentions: result.mentions.slice(0, limit), provider: this.name };
  }
}
