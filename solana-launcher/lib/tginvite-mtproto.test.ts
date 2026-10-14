import { describe, expect, it } from "vitest";
import { toRawMember } from "./tginvite-mtproto";

describe("TGInvite member normalization", () => {
  it("does not expose phone numbers or MTProto access hashes", () => {
    const member = toRawMember({
      className: "User",
      id: 12500,
      username: "example_user",
      phone: "0000000000",
      access_hash: "1234567890",
    });
    expect(member).not.toBeNull();
    expect(member).not.toHaveProperty("phone");
    expect(member).not.toHaveProperty("accessHash");
  });

  it("does not mistake Telegram User.date for account registration", () => {
    const member = toRawMember({
      className: "User",
      id: 12501,
      date: 1720000000,
    });
    expect(member?.createdAt).toBeUndefined();
  });

  it("does not invent exact dates for approximate activity statuses", () => {
    const recently = toRawMember({
      className: "User",
      id: 12502,
      status: { className: "UserStatusRecently" },
    });
    const lastWeek = toRawMember({
      className: "User",
      id: 12503,
      status: { className: "UserStatusLastWeek" },
    });
    expect(recently?.lastSeen).toBeUndefined();
    expect(lastWeek?.lastSeen).toBeUndefined();
  });

  it("retains an exact offline timestamp when Telegram supplies one", () => {
    const member = toRawMember({
      className: "User",
      id: 12504,
      status: { className: "UserStatusOffline", was_online: 1730000000 },
    });
    expect(member?.lastSeen).toEqual(new Date(1730000000 * 1000));
  });

  it("skips entities that are not Telegram users", () => {
    expect(toRawMember({ className: "Channel", id: 19 })).toBeNull();
  });
});
