export interface XTweet {
  id: string;
  author: string;
  authorId?: string | null;
  text: string;
  url: string;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  views: number | null;
  createdAt: number | null;
}

export interface XSearchResult {
  query: string;
  tweets: XTweet[];
  collectedAt: number;
}
