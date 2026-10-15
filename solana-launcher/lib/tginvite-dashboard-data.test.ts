import { describe, expect, it } from "vitest";
import { summarizeTGInviteDashboard } from "./tginvite-dashboard-data";

describe("TGInvite dashboard evidence rules", () => {
  it("uses only stored source metadata and the actual MTProto response", () => {
    expect(summarizeTGInviteDashboard([
      { name: "Verified", username: "verified", verified: true },
      { name: "Imported", username: "imported", verified: false },
    ], {
      channel: "@verified",
      total: 17,
      members: [{ id: 1 }, { id: 2 }],
      partial: true,
      source: "visible_history",
    }, true)).toEqual({
      storedSources: 2,
      previouslyVerifiedSources: 1,
      parsedVisibleMembers: 2,
      parsedReportedTotal: 17,
      parsedChannel: "@verified",
      partialCoverage: true,
      joinRequestLinkReady: true,
      confirmedInvitations: null,
      confirmedJoins: null,
    });
  });

  it("does not invent empty-session invitation counts or parser totals", () => {
    const result = summarizeTGInviteDashboard([], null, false);
    expect(result.storedSources).toBe(0);
    expect(result.parsedVisibleMembers).toBeNull();
    expect(result.parsedReportedTotal).toBeNull();
    expect(result.confirmedInvitations).toBeNull();
    expect(result.confirmedJoins).toBeNull();
  });

  it("never interprets link creation as a confirmed join", () => {
    const result = summarizeTGInviteDashboard([], {
      channel: "@test", total: 0, members: [], partial: false,
    }, true);
    expect(result.joinRequestLinkReady).toBe(true);
    expect(result.confirmedInvitations).toBeNull();
    expect(result.confirmedJoins).toBeNull();
  });

  it("rejects invalid parser totals rather than reporting them", () => {
    const result = summarizeTGInviteDashboard([], {
      channel: "@test", total: -100, members: [], partial: true,
    }, false);
    expect(result.parsedReportedTotal).toBeNull();
  });
});
