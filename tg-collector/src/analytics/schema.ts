export interface SourceAnalyticsRow {
  source_id: string;
  identifier: string;
  posts_7d: number;
  posts_30d: number;
  views_observed_avg: number | null;
  linked_handles: number;
  referenced_contracts: number;
  forwards_observed: number;
}
