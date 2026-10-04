export interface RawMember {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  isBot: boolean;
  isPremium?: boolean;
  isScam?: boolean;
  isFake?: boolean;
  isRestricted?: boolean;
  photo?: { isPersonal: boolean };
  langCode?: string;
  restrictionReason?: string;
  accessHash?: string;
  lastSeen?: Date;
  createdAt?: Date;
}

export interface ActivityScore {
  userId: number;
  score: number;
  reasons: string[];
  isBot: boolean;
  isActive: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface FilterConfig {
  removeBots: boolean;
  removeScam: boolean;
  removeFake: boolean;
  removeRestricted: boolean;
  minActivityScore: number;
  maxAccountAgeDays: number;
  minLastSeenDays: number;
  requireAvatar: boolean;
  requireUsername: boolean;
  minLastSeen?: Date;
  preferredLanguages?: string[];
  blacklistUsernames: string[];
  whitelistUsernames: string[];
  maxResults?: number;
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  removeBots: true,
  removeScam: true,
  removeFake: true,
  removeRestricted: true,
  minActivityScore: 0.3,
  maxAccountAgeDays: 365 * 3,
  minLastSeenDays: 30,
  requireAvatar: false,
  requireUsername: false,
  blacklistUsernames: [],
  whitelistUsernames: [],
  maxResults: 1000,
};

export function scoreActivity(member: RawMember, now: Date = new Date()): ActivityScore {
  let score = 0.5;
  const reasons: string[] = [];

  // --- PENALTIES ---

  // Bot detection
  if (member.isBot) {
    return {
      userId: member.id,
      score: 0,
      reasons: ["is_bot"],
      isBot: true,
      isActive: false,
      riskLevel: "critical",
    };
  }

  // Scam/Fake accounts
  if (member.isScam) {
    score -= 0.5;
    reasons.push("is_scam");
  }
  if (member.isFake) {
    score -= 0.5;
    reasons.push("is_fake");
  }
  if (member.isRestricted) {
    score -= 0.3;
    reasons.push("is_restricted");
  }

  // No profile photo — suspicious
  if (!member.photo || member.photo.isPersonal) {
    score -= 0.1;
    reasons.push("no_avatar");
  }

  // No username — harder to reach, less engaged
  if (!member.username) {
    score -= 0.15;
    reasons.push("no_username");
  }

  // No first name — empty profile
  if (!member.firstName || member.firstName.trim().length === 0) {
    score -= 0.2;
    reasons.push("empty_name");
  }

  // Very short first name — likely throwaway
  if (member.firstName && member.firstName.trim().length <= 1) {
    score -= 0.1;
    reasons.push("short_name");
  }

  // --- BONUSES ---

  // Premium user — likely active and invested
  if (member.isPremium) {
    score += 0.2;
    reasons.push("is_premium");
  }

  // Has avatar — more engaged
  if (member.photo && !member.photo.isPersonal) {
    score += 0.1;
    reasons.push("has_avatar");
  }

  // Has username — public-facing, more accessible
  if (member.username) {
    score += 0.05;
    reasons.push("has_username");
  }

  // Has lang code — shows app usage
  if (member.langCode) {
    score += 0.05;
    reasons.push("has_lang_code");
  }

  // Last seen analysis
  if (member.lastSeen) {
    const daysSinceLastSeen = Math.floor(
      (now.getTime() - member.lastSeen.getTime()) / 86400000
    );

    if (daysSinceLastSeen <= 1) {
      score += 0.3;
      reasons.push("seen_today");
    } else if (daysSinceLastSeen <= 7) {
      score += 0.2;
      reasons.push("seen_this_week");
    } else if (daysSinceLastSeen <= 30) {
      score += 0.1;
      reasons.push("seen_this_month");
    } else if (daysSinceLastSeen <= 90) {
      score -= 0.05;
      reasons.push("seen_3m_ago");
    } else if (daysSinceLastSeen <= 180) {
      score -= 0.15;
      reasons.push("seen_6m_ago");
    } else {
      score -= 0.25;
      reasons.push("seen_long_ago");
    }
  }

  // Account age analysis
  if (member.createdAt) {
    const daysSinceCreation = Math.floor(
      (now.getTime() - member.createdAt.getTime()) / 86400000
    );

    if (daysSinceCreation < 7) {
      score -= 0.2;
      reasons.push("new_account_1w");
    } else if (daysSinceCreation < 30) {
      score -= 0.1;
      reasons.push("new_account_1m");
    } else if (daysSinceCreation > 365) {
      score += 0.1;
      reasons.push("account_1y+");
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(1, score));

  // Determine risk level
  let riskLevel: ActivityScore["riskLevel"];
  if (score >= 0.7) riskLevel = "low";
  else if (score >= 0.4) riskLevel = "medium";
  else if (score >= 0.2) riskLevel = "high";
  else riskLevel = "critical";

  return {
    userId: member.id,
    score,
    reasons,
    isBot: false,
    isActive: score >= 0.4,
    riskLevel,
  };
}

export function filterMembers(
  members: RawMember[],
  config: FilterConfig = DEFAULT_FILTER_CONFIG
): { filtered: RawMember[]; filteredScores: ActivityScore[]; allScores: ActivityScore[]; stats: FilterStats } {
  const now = new Date();
  const allScores: ActivityScore[] = [];
  const filteredScores: ActivityScore[] = [];
  const filtered: RawMember[] = [];
  const stats: FilterStats = {
    total: members.length,
    botsRemoved: 0,
    scamRemoved: 0,
    fakeRemoved: 0,
    restrictedRemoved: 0,
    lowActivityRemoved: 0,
    blacklistRemoved: 0,
    noUsernameRemoved: 0,
    noAvatarRemoved: 0,
    ageRemoved: 0,
    inactiveRemoved: 0,
    passed: 0,
  };

  for (const member of members) {
    const activityScore = scoreActivity(member, now);
    allScores.push(activityScore);

    // 0. Whitelist bypass (before ALL other filters)
    const isWhitelisted =
      member.username &&
      config.whitelistUsernames.includes(member.username.toLowerCase());

    // 1. Remove bots
    if (config.removeBots && activityScore.isBot && !isWhitelisted) {
      stats.botsRemoved++;
      continue;
    }

    // 2. Remove scam/fake/restricted
    if (config.removeScam && member.isScam && !isWhitelisted) {
      stats.scamRemoved++;
      continue;
    }
    if (config.removeFake && member.isFake && !isWhitelisted) {
      stats.fakeRemoved++;
      continue;
    }
    if (config.removeRestricted && member.isRestricted && !isWhitelisted) {
      stats.restrictedRemoved++;
      continue;
    }

    // 4. Blacklist check (only if NOT whitelisted)
    if (
      !isWhitelisted &&
      member.username &&
      config.blacklistUsernames.includes(member.username.toLowerCase())
    ) {
      stats.blacklistRemoved++;
      continue;
    }

    if (!isWhitelisted) {
      // 5. Activity score filter
      if (activityScore.score < config.minActivityScore) {
        stats.lowActivityRemoved++;
        continue;
      }

      // 6. Username requirement
      if (config.requireUsername && !member.username) {
        stats.noUsernameRemoved++;
        continue;
      }

      // 7. Avatar requirement
      if (config.requireAvatar && (!member.photo || member.photo.isPersonal)) {
        stats.noAvatarRemoved++;
        continue;
      }

      // 8. Last seen filter
      if (config.minLastSeenDays > 0) {
        if (!member.lastSeen) {
          // No last seen data — treat as inactive (hidden status)
          stats.inactiveRemoved++;
          continue;
        }
        const daysSinceLastSeen = Math.floor(
          (now.getTime() - member.lastSeen.getTime()) / 86400000
        );
        if (daysSinceLastSeen > config.minLastSeenDays) {
          stats.inactiveRemoved++;
          continue;
        }
      }

      // 9. Account age filter
      if (config.maxAccountAgeDays > 0 && member.createdAt) {
        const daysSinceCreation = Math.floor(
          (now.getTime() - member.createdAt.getTime()) / 86400000
        );
        if (daysSinceCreation > config.maxAccountAgeDays) {
          stats.ageRemoved++;
          continue;
        }
      }
    }

    // 10. Max results limit
    if (config.maxResults && filtered.length >= config.maxResults) {
      break;
    }

    filtered.push(member);
    filteredScores.push(activityScore);
    stats.passed++;
  }

  return { filtered, filteredScores, allScores, stats };
}

export interface FilterStats {
  total: number;
  botsRemoved: number;
  scamRemoved: number;
  fakeRemoved: number;
  restrictedRemoved: number;
  lowActivityRemoved: number;
  blacklistRemoved: number;
  noUsernameRemoved: number;
  noAvatarRemoved: number;
  ageRemoved: number;
  inactiveRemoved: number;
  passed: number;
}

export function getFilterSummary(stats: FilterStats): string[] {
  const lines: string[] = [];
  lines.push(`Total: ${stats.total} users`);
  if (stats.botsRemoved > 0) lines.push(`Bots removed: ${stats.botsRemoved}`);
  if (stats.scamRemoved > 0) lines.push(`Scam removed: ${stats.scamRemoved}`);
  if (stats.fakeRemoved > 0) lines.push(`Fake removed: ${stats.fakeRemoved}`);
  if (stats.restrictedRemoved > 0) lines.push(`Restricted removed: ${stats.restrictedRemoved}`);
  if (stats.lowActivityRemoved > 0) lines.push(`Low activity removed: ${stats.lowActivityRemoved}`);
  if (stats.blacklistRemoved > 0) lines.push(`Blacklisted removed: ${stats.blacklistRemoved}`);
  if (stats.noUsernameRemoved > 0) lines.push(`No username removed: ${stats.noUsernameRemoved}`);
  if (stats.noAvatarRemoved > 0) lines.push(`No avatar removed: ${stats.noAvatarRemoved}`);
  if (stats.ageRemoved > 0) lines.push(`Too old removed: ${stats.ageRemoved}`);
  if (stats.inactiveRemoved > 0) lines.push(`Inactive removed: ${stats.inactiveRemoved}`);
  lines.push(`Passed: ${stats.passed} users (${stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0}%)`);
  return lines;
}

export function parseMemberFromApi(member: Record<string, unknown>): RawMember {
  const user = member.user as Record<string, unknown> | undefined;
  const u = user || member;
  return {
    id: (u.id as number) || 0,
    username: u.username as string | undefined,
    firstName: u.first_name as string | undefined,
    lastName: u.last_name as string | undefined,
    phone: u.phone as string | undefined,
    isBot: (u.is_bot as boolean) || false,
    isPremium: (u.premium as boolean) || false,
    isScam: (u.scam as boolean) || false,
    isFake: (u.fake as boolean) || false,
    isRestricted: (u.restricted as boolean) || false,
    photo: u.photo ? { isPersonal: false } : undefined,
    langCode: u.lang_code as string | undefined,
    restrictionReason: u.restriction_reason as string | undefined,
    lastSeen: u.last_seen_date ? new Date((u.last_seen_date as number) * 1000) : undefined,
    createdAt: u.date ? new Date((u.date as number) * 1000) : undefined,
    accessHash: u.access_hash ? String(u.access_hash) : undefined,
  };
}
