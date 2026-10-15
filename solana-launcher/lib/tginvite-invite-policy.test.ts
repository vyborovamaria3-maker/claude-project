import { describe, expect, it } from "vitest";
import {
  InvalidInviteRequest,
  safeInviteError,
  batchInviteLinkName,
  reconcileInviteToChannelResult,
  validateInviteLinkRequest,
} from "./tginvite-invite-policy";

const required = { token: "123456789:abcdefghijklmnopqrstuvwxyzABCDE123456", chatId: "@example_channel" };

describe("invitation link validation (no Telegram network)", () => {
  it("prepares a bounded single-use link with expiration", () => {
    const o = validateInviteLinkRequest(
      { ...required, expireDays: 2, memberLimit: 1 }, "createLink", 1_700_000_000_000,
    );
    expect(o.expireDate).toBe(1_700_000_000 + 2 * 86400);
    expect(o.count).toBe(1);
    expect(o.memberLimit).toBe(1);
  });

  it("allows join-request links only without member limits", () => {
    expect(validateInviteLinkRequest({
      ...required, createsJoinRequest: true,
    }, "createLink").createsJoinRequest).toBe(true);
    expect(() => validateInviteLinkRequest({
      ...required, createsJoinRequest: true, memberLimit: 1,
    }, "createLink")).toThrow(InvalidInviteRequest);
  });

  it("rejects negative, fractional, excessive and zero batches", () => {
    for (const linkCount of [-1, 0, 1.5, 11, Number.NaN, "10"]) {
      expect(() => validateInviteLinkRequest({
        ...required, linkCount,
      }, "batchLinks")).toThrow(InvalidInviteRequest);
    }
  });

  it("rejects malformed bot tokens without consuming Telegram API quota", () => {
    for (const token of ["", "short", "abc/../../evil", "123:too-short", "12345:"+ "a".repeat(280)]) {
      expect(() => validateInviteLinkRequest({ ...required, token }, "createLink"))
        .toThrow(InvalidInviteRequest);
    }
  });

  it("rejects bad expiration, member limits and chat IDs", () => {
    const invalid = [
      { ...required, expireDays: -1 },
      { ...required, expireDays: "7" },
      { ...required, memberLimit: 100000 },
      { ...required, memberLimit: -5 },
      { ...required, chatId: "https://t.me/+private" },
      { ...required, chatId: "-99999999999999999999" },
    ];
    for (const item of invalid) {
      expect(() => validateInviteLinkRequest(item, "createLink")).toThrow(InvalidInviteRequest);
    }
  });

  it("keeps generated batch link names within Telegram's 32 char limit", () => {
    expect(batchInviteLinkName("a".repeat(32), 10).length).toBe(32);
    expect(batchInviteLinkName("launch", 2)).toBe("launch #2");
  });
});

describe("MTProto invitation receipt reconciliation (mocked results only)", () => {
  it("counts missing users as declined, not successful invitations", () => {
    const result = reconcileInviteToChannelResult([1001, 1002, 1003], {
      updates: {},
      missingInvitees: [{ userId: 1002 }],
    });
    expect(result).toEqual({
      invited: 2, declined: 1, unknown: 0, declinedUserIds: ["1002"],
    });
  });

  it("accepts snake_case MTProto serialization and large user IDs", () => {
    const result = reconcileInviteToChannelResult([9007199254740993n], {
      updates: {},
      missing_invitees: [{ user_id: "9007199254740993" }],
    });
    expect(result.declined).toBe(1);
    expect(result.invited).toBe(0);
  });

  it("handles GramJS integer objects without unsafe JS number conversion", () => {
    const bigIntegerLike = { toString: () => "9007199254740993" };
    const result = reconcileInviteToChannelResult(["9007199254740993"], {
      updates: {},
      missingInvitees: [{ userId: bigIntegerLike }],
    });
    expect(result).toMatchObject({ invited: 0, declined: 1, unknown: 0 });
    const unsafe = reconcileInviteToChannelResult([Number.MAX_SAFE_INTEGER + 2], {
      updates: {}, missingInvitees: [],
    });
    expect(unsafe).toMatchObject({ invited: 0, unknown: 1 });
  });

  it("classifies safe actionable Bot API messages without echoing their originals", () => {
    expect(safeInviteError("Bad Request: chat not found", "123:secret"))
      .toBe("TELEGRAM_CHAT_NOT_FOUND");
    expect(safeInviteError("Forbidden: bot is not a member of the channel chat", "123:secret"))
      .toBe("TELEGRAM_BOT_NEEDS_ADMIN_RIGHTS");
    expect(safeInviteError("Bad Request: not enough rights to manage chat invite links", "123:secret"))
      .toBe("TELEGRAM_BOT_NEEDS_ADMIN_RIGHTS");
    expect(safeInviteError("JOIN_REQUEST_NOT_ENFORCED", "secret"))
      .toBe("JOIN_REQUEST_NOT_ENFORCED");
    expect(safeInviteError("TELEGRAM_RATE_LIMITED", "secret"))
      .toBe("TELEGRAM_RATE_LIMITED");
  });

  it("does not echo bot tokens, URLs or arbitrary Telegram upstream errors", () => {
    expect(safeInviteError("CHAT_ADMIN_REQUIRED", "secret")).toBe("CHAT_ADMIN_REQUIRED");
    const leak = safeInviteError(
      "Bot token 123:longsecret123 & internal URL https://internal.local/",
      "123:longsecret123",
    );
    expect(leak).toBe("Telegram invite link operation failed");
  });

  it("does not invent success when response metadata is missing or malformed", () => {
    expect(reconcileInviteToChannelResult([1, 2], { updates: {} })).toMatchObject({
      invited: 0, declined: 0, unknown: 2,
    });
    expect(reconcileInviteToChannelResult([1], {
      updates: {}, missingInvitees: [{ userId: 99 }],
    }).unknown).toBe(1);
    expect(reconcileInviteToChannelResult([1], {
      missingInvitees: [],
    }).unknown).toBe(1);
    expect(reconcileInviteToChannelResult([1, 1], {
      missingInvitees: [],
    }).unknown).toBe(2);
  });
});
