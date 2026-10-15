"use client";

import { useMemo } from "react";
import { Activity, Bot, Globe, Link2, Users } from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";
import {
  summarizeTGInviteDashboard,
  type TGInviteSourceSummary,
  type TGInviteParserSummary,
} from "@/lib/tginvite-dashboard-data";

interface EnhancedDashboardProps {
  sources: readonly TGInviteSourceSummary[];
  parser: TGInviteParserSummary | null;
  hasJoinRequestLink: boolean;
  botVerified: boolean;
}

function metric(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

/**
 * Live workspace overview. There is no invitation-dispatch ledger yet:
 * never replace unknown counts with synthetic chart data or browser job totals.
 */
export default function EnhancedDashboard({
  sources, parser, hasJoinRequestLink, botVerified,
}: EnhancedDashboardProps) {
  const summary = useMemo(
    () => summarizeTGInviteDashboard(sources, parser, hasJoinRequestLink),
    [sources, parser, hasJoinRequestLink],
  );
  const cards = [
    {
      name: "Saved sources",
      value: metric(summary.storedSources),
      help: "Locally saved; not necessarily accessible now.",
    },
    {
      name: "Previously verified sources",
      value: metric(summary.previouslyVerifiedSources),
      help: "Verified when saved; access can change.",
    },
    {
      name: "Profiles shown in latest parse",
      value: metric(summary.parsedVisibleMembers),
      help: summary.parsedChannel ?? "Run the parser to see real observations.",
    },
    {
      name: "Confirmed invitations",
      value: metric(summary.confirmedInvitations),
      help: "Unavailable without a server-owned dispatch receipt ledger.",
    },
    {
      name: "Confirmed joins",
      value: metric(summary.confirmedJoins),
      help: "Creating a link does not mean a user joined.",
    },
  ];

  return (
    <section className="space-y-6" aria-label="TGInvite workspace dashboard">
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-[color:var(--theme-primary)]" />
          <div>
            <h2 className="text-2xl font-bold">Telegram workspace overview</h2>
            <p className="mt-1 text-sm text-content-muted">
              Only observed Telegram parser data and saved source records are shown.
              Invitation and join metrics remain unknown until verified receipts exist.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {cards.map((card) => (
          <div className={siteDesign.page.panelClassName} key={card.name}>
            <div className="text-xs text-content-muted">{card.name}</div>
            <div className="mt-2 text-2xl font-bold text-content">{card.value}</div>
            <div className="mt-2 text-xs text-content-muted">{card.help}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={siteDesign.page.panelClassName}>
          <h3 className="flex items-center gap-2 font-semibold">
            <Users className="h-5 w-5" />
            Latest Telegram parser result
          </h3>
          {parser ? (
            <div className="mt-4 space-y-2 text-sm">
              <p>Source: <span className="font-medium">{summary.parsedChannel}</span></p>
              <p>Profiles fetched before display filters: {metric(summary.parsedReportedTotal)}</p>
              <p>Profiles shown: {metric(summary.parsedVisibleMembers)}</p>
              <p className="text-content-muted">
                {summary.partialCoverage
                  ? "Partial coverage: Telegram only exposed visible accounts from accessible chat history."
                  : "Visible data only: a non-partial response is not proof of a full membership census."}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-content-muted" role="status">
              No parser result in this browser session. Use the Parser tab to fetch Telegram data.
            </p>
          )}
        </div>

        <div className={siteDesign.page.panelClassName}>
          <h3 className="flex items-center gap-2 font-semibold">
            <Link2 className="h-5 w-5" />
            Invitation readiness
          </h3>
          <div className="mt-4 space-y-2 text-sm">
            <p className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              Bot: {botVerified ? "verified in this session" : "not verified in this session"}
            </p>
            <p>
              Join-request link: {summary.joinRequestLinkReady
                ? "confirmed by Telegram in this session"
                : "not created in this session"}
            </p>
            <p className="text-content-muted">
              Invite candidates cannot be bulk-added from parser results.
              People must choose to request access, and an administrator must approve.
            </p>
          </div>
        </div>
      </div>

      <div className={siteDesign.page.panelClassName}>
        <h3 className="flex items-center gap-2 font-semibold">
          <Globe className="h-5 w-5" />
          Saved source list
        </h3>
        {sources.length > 0 ? (
          <ul className="mt-3 divide-y divide-bg-border text-sm">
            {sources.slice(0, 10).map((source, index) => (
              <li key={index} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">{source.name || source.username}</span>
                <span className="text-xs text-content-muted">
                  {source.verified === true ? "Previously verified" : "Not verified"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-content-muted">
            No sources have been saved. Add sources or parse a Telegram chat.
          </p>
        )}
        {sources.length > 10 && (
          <p className="mt-3 text-xs text-content-muted">
            Showing 10 of {sources.length} locally saved sources.
          </p>
        )}
      </div>
    </section>
  );
}
