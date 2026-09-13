// data-tag: lib.trade.twitter_scraper
// Twitter/X scraping using hybrid architecture: Nitter (fast) + Playwright (heavy)
// Smart routing with auto-fallback between strategies

export { TwitterScraper } from "./twitter-scraper-core";
export type { ScrapedTweet, TwitterProfile, TwitterSearchResult } from "./twitter-scraper-core";
