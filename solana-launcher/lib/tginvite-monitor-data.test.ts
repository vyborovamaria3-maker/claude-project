import { describe, expect, it } from "vitest";
import { parseTGInviteAuditJobs } from "./tginvite-monitor-data";

const row = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  destination_chat_id: "-100123456789",
  status: "blocked_transport",
  created_at: "2026-10-15T02:00:00Z",
};

describe("TGInvite audit monitor contract", () => {
  it("accepts only owner-scoped blocked/cancelled audit rows and strips unrelated fields", () => {
    expect(parseTGInviteAuditJobs([
      { ...row, consent_digest: "do-not-render", recipient_id: "private" },
      { ...row, id: "123e4567-e89b-42d3-a456-426614174001", status: "cancelled" },
    ])).toEqual([
      row,
      { ...row, id: "123e4567-e89b-42d3-a456-426614174001", status: "cancelled" },
    ]);
  });

  it("refuses fake invitation success, unexpected records and unbounded results", () => {
    const invalidRows = [
      { ...row, status: "sent" },
      { ...row, status: "completed" },
      { ...row, id: "malformed" },
      { ...row, destination_chat_id: "<script>" },
      { ...row, created_at: "not a date" },
      null,
    ];
    for (const bad of invalidRows) {
      expect(() => parseTGInviteAuditJobs([bad])).toThrow();
    }
    expect(() => parseTGInviteAuditJobs({ jobs: [row] })).toThrow();
    expect(() => parseTGInviteAuditJobs(Array(101).fill(row))).toThrow();
  });

  it("does not infer any sent invitations from an empty or blocked audit ledger", () => {
    expect(parseTGInviteAuditJobs([])).toEqual([]);
    expect(parseTGInviteAuditJobs([row])[0].status).toBe("blocked_transport");
  });
});
