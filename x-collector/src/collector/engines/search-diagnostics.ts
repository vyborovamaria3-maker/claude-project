/** Non-sensitive DOM signals that distinguish a missing feed from a parser change. */
export interface SearchDomSignals {
  articleNodes: number;
  errorBanner: boolean;
  loading: boolean;
}

/** Never log page text, query parameters, cookies or full DOM snapshots. */
export function searchFailureMessage(signals: SearchDomSignals | null): string {
  if (signals && Number.isSafeInteger(signals.articleNodes) && signals.articleNodes > 0) {
    return `SEARCH_PARSE_UNCONFIRMED: ${signals.articleNodes} tweet article nodes produced no valid posts`;
  }
  return `SEARCH_UNCONFIRMED: no tweets and no explicit empty state; ` +
    `errorBanner=${Boolean(signals?.errorBanner)}; loading=${Boolean(signals?.loading)}; inspection=${signals ? "ok" : "unavailable"}`;
}
