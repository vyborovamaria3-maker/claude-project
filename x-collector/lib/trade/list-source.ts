export function listId(query: string): string | null {
  return /^list:(\d{1,25})$/.exec(query)?.[1] ?? null;
}
export function collectionUrl(query: string, sort: 'top' | 'latest'): string {
  const id = listId(query);
  return id ? `https://x.com/i/lists/${id}`
    : `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${sort === 'latest' ? 'live' : 'top'}`;
}
