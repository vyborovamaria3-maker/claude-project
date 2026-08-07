import type { XMention } from '@/server/xanalysis/xsearch.js';

export type SearchOptions = { limit?: number };
export type ProviderSearchResult = { mentions: XMention[]; truncated: boolean; provider: string };

export interface SocialDataProvider {
  readonly name: string;
  isConfigured(): boolean;
  search(query: string, options?: SearchOptions): Promise<ProviderSearchResult>;
}
