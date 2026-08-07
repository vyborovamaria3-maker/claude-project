import type { XMention } from './xsearch.js';

export type AnalysisConfidence = 'low' | 'medium' | 'high';
export type AnalysisVerdict = 'insufficient' | 'organic' | 'mixed' | 'coordinated';
export type AnalysisFlagKind = 'positive' | 'info' | 'warning' | 'risk';

export type AnalysisFlag = {
  kind: AnalysisFlagKind;
  title: string;
  detail: string;
};

export type DuplicateCluster = {
  count: number;
  text: string;
  authors: string[];
};

export type MentionAnalysis = {
  sampleSize: number;
  uniqueAuthors: number;
  combinedFollowers: number;
  largestAuthorFollowers: number;
  medianAuthorFollowers: number;
  totalViews: number;
  viewsCoverage: number;
  totalEngagement: number;
  averageEngagement: number;
  engagementRate: number | null;
  verifiedAuthors: number;
  verifiedAuthorShare: number;
  newAccountAuthors: number;
  newAccountShare: number;
  suspiciousAuthors: number;
  suspiciousAuthorShare: number;
  repeatedPosts: number;
  repeatedPostShare: number;
  topAuthorShare: number;
  top3AuthorShare: number;
  postsLastHour: number;
  postsLast6Hours: number;
  postsLast24Hours: number;
  observedWindowHours: number | null;
  sampleVelocityPerHour: number | null;
  qualityScore: number | null;
  confidence: AnalysisConfidence;
  verdict: AnalysisVerdict;
  flags: AnalysisFlag[];
  duplicateClusters: DuplicateCluster[];
};

const DAY_MS = 86_400_000;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function accountAgeDays(joinedAt: Date | null, now: Date): number | null {
  if (!joinedAt) return null;
  const age = (now.getTime() - joinedAt.getTime()) / DAY_MS;
  return Number.isFinite(age) ? Math.max(0, age) : null;
}

/**
 * Conservative heuristic, not a bot verdict. It only marks accounts with a
 * combination commonly seen in disposable shill profiles: very new, extreme
 * following-to-follower imbalance, or huge posting volume with almost no reach.
 */
function looksSuspicious(author: XMention['author'], now: Date): boolean {
  const ageDays = accountAgeDays(author.joinedAt, now);
  const veryNew = ageDays !== null && ageDays < 14;
  const extremeFollowing = author.followers < 50 && author.following >= 500;
  const highOutputLowReach = author.followers < 100 && author.posts >= 5_000;
  return author.handle === 'unknown' || veryNew || extremeFollowing || highOutputLowReach;
}

function normalizePostText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[a-z0-9_]+/gi, ' ')
    .replace(/\$[a-z0-9_]+/gi, ' ')
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeMentions(mentions: XMention[]): XMention[] {
  const unique = new Map<string, XMention>();
  for (const mention of mentions) unique.set(mention.id, mention);
  return [...unique.values()];
}

function duplicateAnalysis(mentions: XMention[]) {
  const groups = new Map<string, XMention[]>();

  for (const mention of mentions) {
    const normalized = normalizePostText(mention.text);
    if (normalized.length < 12) continue;
    const group = groups.get(normalized) ?? [];
    group.push(mention);
    groups.set(normalized, group);
  }

  const repeatedGroups = [...groups.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => b.length - a.length);

  const repeatedIds = new Set(repeatedGroups.flatMap((group) => group.map((mention) => mention.id)));
  const duplicateClusters: DuplicateCluster[] = repeatedGroups.slice(0, 5).map((group) => ({
    count: group.length,
    text: group[0].text.trim().slice(0, 180),
    authors: [...new Set(group.map((mention) => mention.author.handle))].slice(0, 6),
  }));

  return { repeatedPosts: repeatedIds.size, duplicateClusters };
}

function confidenceFor(sampleSize: number): AnalysisConfidence {
  if (sampleSize >= 30) return 'high';
  if (sampleSize >= 10) return 'medium';
  return 'low';
}

function verdictFor(sampleSize: number, qualityScore: number | null): AnalysisVerdict {
  if (sampleSize < 5 || qualityScore === null) return 'insufficient';
  if (qualityScore >= 75) return 'organic';
  if (qualityScore >= 50) return 'mixed';
  return 'coordinated';
}

export function analyzeMentions(
  input: XMention[],
  { now = new Date(), truncated = false }: { now?: Date; truncated?: boolean } = {}
): MentionAnalysis {
  const mentions = dedupeMentions(input);
  const sampleSize = mentions.length;

  const authorMap = new Map<string, XMention['author']>();
  const authorPostCounts = new Map<string, number>();
  for (const mention of mentions) {
    authorMap.set(mention.author.handle, mention.author);
    authorPostCounts.set(mention.author.handle, (authorPostCounts.get(mention.author.handle) ?? 0) + 1);
  }

  const authors = [...authorMap.values()];
  const uniqueAuthors = authors.length;
  const followerCounts = authors.map((author) => Math.max(0, author.followers));
  const combinedFollowers = followerCounts.reduce((sum, value) => sum + value, 0);
  const largestAuthorFollowers = followerCounts.length > 0 ? Math.max(...followerCounts) : 0;
  const medianAuthorFollowers = median(followerCounts);

  const verifiedAuthors = authors.filter((author) => author.isVerified).length;
  const newAccountAuthors = authors.filter((author) => {
    const age = accountAgeDays(author.joinedAt, now);
    return age !== null && age < 30;
  }).length;
  const suspiciousAuthors = authors.filter((author) => looksSuspicious(author, now)).length;

  const totalViews = mentions.reduce((sum, mention) => sum + Math.max(0, mention.views), 0);
  const postsWithViews = mentions.filter((mention) => mention.views > 0).length;
  const totalEngagement = mentions.reduce((sum, mention) => sum + Math.max(0, mention.engagement), 0);
  const averageEngagement = sampleSize > 0 ? totalEngagement / sampleSize : 0;
  const engagementRate = totalViews > 0 ? (totalEngagement / totalViews) * 100 : null;

  const { repeatedPosts, duplicateClusters } = duplicateAnalysis(mentions);
  const repeatedPostShare = ratio(repeatedPosts, sampleSize);

  const authorCounts = [...authorPostCounts.values()].sort((a, b) => b - a);
  const topAuthorShare = ratio(authorCounts[0] ?? 0, sampleSize);
  const top3AuthorShare = ratio(authorCounts.slice(0, 3).reduce((sum, count) => sum + count, 0), sampleSize);

  const validDates = mentions
    .map((mention) => mention.createdAt)
    .filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()));
  const ageHours = validDates.map((date) => Math.max(0, (now.getTime() - date.getTime()) / 3_600_000));
  const postsLastHour = ageHours.filter((hours) => hours <= 1).length;
  const postsLast6Hours = ageHours.filter((hours) => hours <= 6).length;
  const postsLast24Hours = ageHours.filter((hours) => hours <= 24).length;

  let observedWindowHours: number | null = null;
  let sampleVelocityPerHour: number | null = null;
  if (validDates.length >= 2) {
    const timestamps = validDates.map((date) => date.getTime());
    const windowMs = Math.max(...timestamps) - Math.min(...timestamps);
    observedWindowHours = Math.max(windowMs / 3_600_000, 1 / 60);
    sampleVelocityPerHour = validDates.length / observedWindowHours;
  }

  const uniqueAuthorShare = ratio(uniqueAuthors, sampleSize);
  const suspiciousAuthorShare = ratio(suspiciousAuthors, uniqueAuthors);
  const concentrationQuality = 1 - top3AuthorShare;
  const qualityScore =
    sampleSize < 5
      ? null
      : Math.round(
          100 *
            clamp(
              (1 - repeatedPostShare) * 0.3 +
                (1 - suspiciousAuthorShare) * 0.25 +
                uniqueAuthorShare * 0.25 +
                concentrationQuality * 0.2
            )
        );

  const flags: AnalysisFlag[] = [];
  if (sampleSize < 5) {
    flags.push({
      kind: 'info',
      title: 'Small sample',
      detail: 'Fewer than five posts were returned, so authenticity conclusions are unreliable.',
    });
  }
  if (truncated) {
    flags.push({
      kind: 'info',
      title: 'Partial search window',
      detail: 'The provider had more pages than the configured search limit, so totals are a sample.',
    });
  }
  if (sampleSize >= 5 && uniqueAuthorShare >= 0.8) {
    flags.push({
      kind: 'positive',
      title: 'Broad author diversity',
      detail: `${Math.round(uniqueAuthorShare * 100)}% of sampled posts came from distinct accounts.`,
    });
  }
  if (repeatedPostShare >= 0.35) {
    flags.push({
      kind: 'risk',
      title: 'Heavy copy-paste activity',
      detail: `${Math.round(repeatedPostShare * 100)}% of sampled posts belong to repeated text clusters.`,
    });
  } else if (repeatedPostShare >= 0.15) {
    flags.push({
      kind: 'warning',
      title: 'Some repeated messaging',
      detail: `${Math.round(repeatedPostShare * 100)}% of sampled posts reuse substantially identical text.`,
    });
  }
  if (suspiciousAuthorShare >= 0.35) {
    flags.push({
      kind: 'risk',
      title: 'Many low-trust profiles',
      detail: `${Math.round(suspiciousAuthorShare * 100)}% of unique authors match conservative risk heuristics.`,
    });
  } else if (suspiciousAuthorShare >= 0.2) {
    flags.push({
      kind: 'warning',
      title: 'Low-trust profiles present',
      detail: `${Math.round(suspiciousAuthorShare * 100)}% of unique authors match conservative risk heuristics.`,
    });
  }
  if (sampleSize >= 8 && top3AuthorShare >= 0.7) {
    flags.push({
      kind: 'warning',
      title: 'Conversation is concentrated',
      detail: `The three most active accounts produced ${Math.round(top3AuthorShare * 100)}% of sampled posts.`,
    });
  }
  if (uniqueAuthors >= 5 && ratio(newAccountAuthors, uniqueAuthors) >= 0.4) {
    flags.push({
      kind: 'warning',
      title: 'Many recently created accounts',
      detail: `${Math.round(ratio(newAccountAuthors, uniqueAuthors) * 100)}% of authors joined X within 30 days.`,
    });
  }
  if (sampleSize > 0 && ratio(postsWithViews, sampleSize) < 0.5) {
    flags.push({
      kind: 'info',
      title: 'Incomplete view data',
      detail: 'View counts are missing on more than half of sampled posts; engagement rate is less reliable.',
    });
  }

  return {
    sampleSize,
    uniqueAuthors,
    combinedFollowers,
    largestAuthorFollowers,
    medianAuthorFollowers,
    totalViews,
    viewsCoverage: ratio(postsWithViews, sampleSize),
    totalEngagement,
    averageEngagement,
    engagementRate,
    verifiedAuthors,
    verifiedAuthorShare: ratio(verifiedAuthors, uniqueAuthors),
    newAccountAuthors,
    newAccountShare: ratio(newAccountAuthors, uniqueAuthors),
    suspiciousAuthors,
    suspiciousAuthorShare,
    repeatedPosts,
    repeatedPostShare,
    topAuthorShare,
    top3AuthorShare,
    postsLastHour,
    postsLast6Hours,
    postsLast24Hours,
    observedWindowHours,
    sampleVelocityPerHour,
    qualityScore,
    confidence: confidenceFor(sampleSize),
    verdict: verdictFor(sampleSize, qualityScore),
    flags,
    duplicateClusters,
  };
}
