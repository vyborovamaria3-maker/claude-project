const RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 60 * 1000;
const RECHECK_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 3 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const URL_PATTERN = /https?:\/\/[^\s]+/gi;
const SOURCE_STATUS_PATTERN = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:i\/status\/\d+|[A-Za-z0-9_]{1,15}\/status\/\d+)/i;

function urls(text) {
  return String(text || '').match(URL_PATTERN) || [];
}

function normalizeBody(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function comparableText(job, candidateText) {
  const jobText = String(job.content || '');
  const expectedUrls = urls(jobText);
  const candidateUrls = urls(candidateText);
  const stripSourceLink = job.origin === 'agent' && expectedUrls.length === 1 && SOURCE_STATUS_PATTERN.test(jobText);
  if (stripSourceLink) {
    if (candidateUrls.length !== 1) return false;
    return normalizeBody(jobText.replace(URL_PATTERN, ' ')) === normalizeBody(String(candidateText || '').replace(URL_PATTERN, ' '));
  }
  return normalizeBody(jobText) === normalizeBody(candidateText);
}

function timestampFromId(id) {
  try {
    if (!/^\d{1,25}$/.test(String(id || ''))) return null;
    const timestamp = Number((BigInt(id) >> 22n) + 1288834974657n);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

function candidateTimestamp(candidate) {
  if (candidate.posted_at !== null && candidate.posted_at !== undefined) {
    const value = Number(candidate.posted_at);
    if (Number.isFinite(value) && value > 0) return value;
  }
  if (candidate.created_at) {
    const parsed = Date.parse(candidate.created_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return timestampFromId(candidate.tweet_id || candidate.id);
}

function findMatches(job, candidates, now = Date.now()) {
  if (!job || !Array.isArray(candidates)) return [];
  const expectedHandle = String(job.expected_handle || '').replace(/^@/, '').toLowerCase();
  const attemptedAt = Number(job.attempted_at ?? job.started_at ?? job.created_at);
  if (!expectedHandle || !Number.isFinite(attemptedAt) || attemptedAt <= 0) return [];
  const minTime = attemptedAt - 2 * 60 * 1000;
  const maxTime = now + 2 * 60 * 1000;
  const matches = new Map();

  for (const candidate of candidates) {
    const tweetId = String(candidate?.tweet_id || candidate?.id || '');
    const handle = String(candidate?.handle || '').replace(/^@/, '').toLowerCase();
    if (!/^\d{1,25}$/.test(tweetId) || handle !== expectedHandle) continue;
    const postedAt = candidateTimestamp(candidate);
    if (!Number.isFinite(postedAt) || postedAt < minTime || postedAt > maxTime) continue;
    if (!comparableText(job, candidate.text)) continue;
    matches.set(tweetId, { ...candidate, tweet_id: tweetId, posted_at: postedAt });
  }
  return [...matches.values()].sort((a, b) => a.posted_at - b.posted_at);
}

function decideReconciliation({ kind, matches, now, deadlineAt }) {
  if (!['post', 'reply'].includes(kind)) return { status: 'manual_review', reason: 'UNSUPPORTED_ACTION' };
  if (matches.length === 1) return { status: 'resolved', reason: 'EXACT_MATCH', match: matches[0] };
  if (matches.length > 1) return { status: 'manual_review', reason: 'MULTIPLE_MATCHES' };
  if (now >= deadlineAt) return { status: 'manual_required', reason: 'NOT_FOUND_WITHIN_WINDOW' };
  return { status: 'retry', reason: 'NOT_FOUND_YET' };
}

function nextCheckDelayMs(attempts) {
  const count = Number(attempts);
  const index = Number.isInteger(count) ? Math.max(0, Math.min(count - 1, RECHECK_DELAYS_MS.length - 1)) : 0;
  return RECHECK_DELAYS_MS[index];
}

function nextCheckAt(now, attempts, deadlineAt) {
  return Math.min(Number(deadlineAt), Number(now) + nextCheckDelayMs(attempts));
}

module.exports = {
  RECONCILIATION_WINDOW_MS,
  INITIAL_CHECK_DELAY_MS,
  RECHECK_DELAYS_MS,
  findMatches,
  decideReconciliation,
  nextCheckDelayMs,
  nextCheckAt,
  timestampFromId,
};