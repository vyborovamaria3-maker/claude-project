/**
 * Owner-facing TGInvite dashboard totals. The only source of member counts is
 * the current MTProto parser response; browser-only jobs never prove invites.
 */
export interface TGInviteSourceSummary {
  name: string;
  username: string;
  verified?: boolean;
}

export interface TGInviteParserSummary {
  channel: string;
  total: number;
  members: readonly unknown[];
  partial?: boolean;
  source?: string;
}

export interface TGInviteDashboardSummary {
  storedSources: number;
  previouslyVerifiedSources: number;
  parsedVisibleMembers: number | null;
  parsedReportedTotal: number | null;
  parsedChannel: string | null;
  partialCoverage: boolean | null;
  joinRequestLinkReady: boolean;
  confirmedInvitations: null;
  confirmedJoins: null;
}

export function summarizeTGInviteDashboard(
  sources: readonly TGInviteSourceSummary[],
  parser: TGInviteParserSummary | null,
  joinRequestLinkReady: boolean,
): TGInviteDashboardSummary {
  const count = parser?.members.length;
  return {
    storedSources: sources.length,
    previouslyVerifiedSources: sources.filter((source) => source.verified === true).length,
    parsedVisibleMembers: parser && Number.isSafeInteger(count) ? count! : null,
    parsedReportedTotal: parser && Number.isSafeInteger(parser.total) && parser.total >= 0 ? parser.total : null,
    parsedChannel: parser?.channel || null,
    // Partial results are known incomplete. Non-partial results are still only
    // observations accessible to the connected account, not a full census.
    partialCoverage: parser ? parser.partial === true : null,
    joinRequestLinkReady,
    confirmedInvitations: null,
    confirmedJoins: null,
  };
}
