import { describe, it, expect } from "vitest";
import { scoreActivity, filterMembers, DEFAULT_FILTER_CONFIG, RawMember } from "./tginvite-filter";

function makeMember(overrides: Partial<RawMember> = {}): RawMember {
  return {
    id: 1,
    isBot: false,
    ...overrides,
  };
}

describe("scoreActivity", () => {
  it("returns 0 for bots", () => {
    const member = makeMember({ isBot: true });
    const result = scoreActivity(member);
    expect(result.score).toBe(0);
    expect(result.isBot).toBe(true);
    expect(result.riskLevel).toBe("critical");
  });

  it("penalizes scam accounts", () => {
    const member = makeMember({ isScam: true });
    const result = scoreActivity(member);
    expect(result.score).toBeLessThan(0.5);
  });

  it("penalizes fake accounts", () => {
    const member = makeMember({ isFake: true });
    const result = scoreActivity(member);
    expect(result.score).toBeLessThan(0.5);
  });

  it("penalizes no avatar", () => {
    const member = makeMember();
    const result = scoreActivity(member);
    expect(result.score).toBeLessThan(0.5);
  });

  it("penalizes no username", () => {
    const member = makeMember();
    const result = scoreActivity(member);
    expect(result.score).toBeLessThan(0.5);
  });

  it("penalizes empty name", () => {
    const member = makeMember({ firstName: "" });
    const result = scoreActivity(member);
    expect(result.score).toBeLessThan(0.5);
  });

  it("penalizes short name", () => {
    const member = makeMember({ firstName: "A" });
    const result = scoreActivity(member);
    expect(result.score).toBeLessThan(0.5);
  });

  it("bonuses premium users", () => {
    const member = makeMember({
      isPremium: true,
      username: "testuser",
      firstName: "Test",
      photo: { isPersonal: false },
    });
    const result = scoreActivity(member);
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.reasons).toContain("is_premium");
  });

  it("bonuses users with avatar", () => {
    const member = makeMember({
      username: "testuser",
      firstName: "Test",
      photo: { isPersonal: false },
    });
    const result = scoreActivity(member);
    expect(result.reasons).toContain("has_avatar");
  });

  it("bonuses users with lang code", () => {
    const member = makeMember({
      username: "testuser",
      firstName: "Test",
      langCode: "en",
    });
    const result = scoreActivity(member);
    expect(result.reasons).toContain("has_lang_code");
  });

  it("scores recently seen users higher", () => {
    const memberRecent = makeMember({
      username: "testuser",
      firstName: "Test",
      lastSeen: new Date(),
    });
    const memberOld = makeMember({
      id: 2,
      username: "testuser2",
      firstName: "Test",
      lastSeen: new Date(Date.now() - 90 * 86400000),
    });
    const recent = scoreActivity(memberRecent);
    const old = scoreActivity(memberOld);
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it("scores old accounts higher", () => {
    const memberNew = makeMember({
      username: "testuser",
      firstName: "Test",
      createdAt: new Date(Date.now() - 3 * 86400000),
    });
    const memberOld = makeMember({
      id: 2,
      username: "testuser2",
      firstName: "Test",
      createdAt: new Date(Date.now() - 400 * 86400000),
    });
    const newAcc = scoreActivity(memberNew);
    const oldAcc = scoreActivity(memberOld);
    expect(oldAcc.score).toBeGreaterThan(newAcc.score);
  });

  it("clamps score to 0-1 range", () => {
    const member = makeMember({
      isPremium: true,
      username: "testuser",
      firstName: "Test",
      photo: { isPersonal: false },
      langCode: "en",
      lastSeen: new Date(),
      createdAt: new Date(Date.now() - 400 * 86400000),
    });
    const result = scoreActivity(member);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("determines risk level correctly", () => {
    const lowRisk = scoreActivity(makeMember({
      isPremium: true, username: "user1", firstName: "Test",
      photo: { isPersonal: false }, langCode: "en",
      lastSeen: new Date(), createdAt: new Date(Date.now() - 400 * 86400000),
    }));
    expect(lowRisk.riskLevel).toBe("low");

    const highRisk = scoreActivity(makeMember({
      id: 2, isScam: true,
    }));
    expect(highRisk.riskLevel).toBe("critical");
  });
});

describe("filterMembers", () => {
  const members: RawMember[] = [
    makeMember({ id: 1, isBot: true, username: "bot1", firstName: "Bot" }),
    makeMember({ id: 2, isScam: true, username: "scam1", firstName: "Scam" }),
    makeMember({ id: 3, isFake: true, username: "fake1", firstName: "Fake" }),
    makeMember({ id: 4, isRestricted: true, username: "restricted1", firstName: "Restricted" }),
    makeMember({ id: 5, username: "user1", firstName: "Active", photo: { isPersonal: false }, langCode: "en", lastSeen: new Date() }),
    makeMember({ id: 6, username: "user2", firstName: "Active2", photo: { isPersonal: false }, lastSeen: new Date() }),
    makeMember({ id: 7, username: "inactive1", firstName: "Old", lastSeen: new Date(Date.now() - 180 * 86400000) }),
    makeMember({ id: 8, username: "blacklisted", firstName: "Blacklisted" }),
    makeMember({ id: 9, firstName: "NoUsername" }),
    makeMember({ id: 10, username: "user3", firstName: "NoAvatar" }),
  ];

  it("removes bots when removeBots is true", () => {
    const result = filterMembers(members, { ...DEFAULT_FILTER_CONFIG, removeBots: true });
    expect(result.stats.botsRemoved).toBe(1);
  });

  it("removes scam accounts when removeScam is true", () => {
    const result = filterMembers(members, { ...DEFAULT_FILTER_CONFIG, removeScam: true });
    expect(result.stats.scamRemoved).toBe(1);
  });

  it("removes fake accounts when removeFake is true", () => {
    const result = filterMembers(members, { ...DEFAULT_FILTER_CONFIG, removeFake: true });
    expect(result.stats.fakeRemoved).toBe(1);
  });

  it("removes restricted accounts when removeRestricted is true", () => {
    const result = filterMembers(members, { ...DEFAULT_FILTER_CONFIG, removeRestricted: true });
    expect(result.stats.restrictedRemoved).toBe(1);
  });

  it("respects maxResults", () => {
    const result = filterMembers(members, { ...DEFAULT_FILTER_CONFIG, maxResults: 2 });
    expect(result.filtered.length).toBeLessThanOrEqual(2);
  });

  it("returns all scores", () => {
    const result = filterMembers(members);
    expect(result.allScores.length).toBe(members.length);
  });

  it("whitelist bypasses filters", () => {
    const result = filterMembers(
      [makeMember({ id: 1, isBot: true, username: "mybot", firstName: "Bot" })],
      { ...DEFAULT_FILTER_CONFIG, removeBots: true, whitelistUsernames: ["mybot"] }
    );
    expect(result.filtered.length).toBe(1);
  });

  it("blacklist removes users", () => {
    const result = filterMembers(
      [makeMember({ id: 1, username: "baduser", firstName: "Bad" })],
      { ...DEFAULT_FILTER_CONFIG, blacklistUsernames: ["baduser"] }
    );
    expect(result.stats.blacklistRemoved).toBe(1);
  });

  it("whitelist takes priority over blacklist", () => {
    const result = filterMembers(
      [makeMember({ id: 1, username: "vip", firstName: "VIP" })],
      { ...DEFAULT_FILTER_CONFIG, blacklistUsernames: ["vip"], whitelistUsernames: ["vip"] }
    );
    expect(result.filtered.length).toBe(1);
  });
});
