export interface XTweet {
  id: string;
  author: string;
  text: string;
  url: string;
  likes: number;
  reposts: number;
  replies: number;
  views: number;
  createdAt: number | null;
}

export interface XSearchResult {
  query: string;
  tweets: XTweet[];
  collectedAt: number;
}
