import type { XMention } from './xsearch.js';
import { aggregateAccountFeatures, type AccountFeatures } from './features.js';

export type AccountRole = 'originator' | 'amplifier' | 'influencer' | 'community' | 'high-risk' | 'participant';
export type EdgeReason = 'time' | 'text' | 'links' | 'contracts' | 'mentions' | 'hashtags' | 'tickers' | 'fingerprint';

export type NetworkNode = {
  handle: string; name: string; profileUrl: string; avatarUrl: string | null; followers: number; posts: number;
  firstPostAt: Date | null; lastPostAt: Date | null; averageDelayMinutes: number | null; influenceScore: number;
  coordinationScore: number; role: AccountRole; sharedContracts: number; sharedLinks: number;
};
export type NetworkEdge = {
  source: string; target: string; weight: number;
  reasons: { kind: EdgeReason; score: number; detail: string }[];
  averageDelayMinutes: number | null;
};
export type AccountCluster = {
  id: string; handles: string[]; size: number; density: number; coordinationScore: number;
  likelyOriginator: string | null; commonContracts: string[]; commonLinks: string[];
  commonHashtags: string[]; medianDelayMinutes: number | null;
};
export type PropagationEvent = {
  id: string; handle: string; createdAt: Date | null; delayFromFirstMinutes: number | null;
  url: string; excerpt: string; context: 'contract' | 'ticker' | 'both' | 'unknown';
};
export type MacroNetworkAnalysis = {
  nodeCount: number; edgeCount: number; clusterCount: number; networkDensity: number;
  coordinationScore: number; organicScore: number; likelyOriginator: string | null;
  medianPropagationDelayMinutes: number | null; copySimilarityPeak: number;
  candidatePairCount: number; possiblePairCount: number; pruningRatio: number; analysisMs: number;
  nodes: NetworkNode[]; edges: NetworkEdge[]; clusters: AccountCluster[]; timeline: PropagationEvent[];
};

type Options = {
  address: string;
  symbol: string | null;
  maxCandidatePairs?: number;
  maxFeatureFanout?: number;
  timeBucketMinutes?: number;
};

function clamp(value: number, min = 0, max = 1) { return Math.min(max, Math.max(min, value)); }
function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}
function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  let intersection = 0;
  for (const item of smaller) if (larger.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}
function sharedCount(left: Set<string>, right: Set<string>): number {
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  let count = 0;
  for (const item of smaller) if (larger.has(item)) count += 1;
  return count;
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function contextFor(text: string, address: string, symbol: string | null): PropagationEvent['context'] {
  const hasAddress = text.toLowerCase().includes(address.toLowerCase());
  const hasTicker = Boolean(symbol && new RegExp(`\\$${escapeRegExp(symbol)}\\b`, 'i').test(text));
  return hasAddress && hasTicker ? 'both' : hasAddress ? 'contract' : hasTicker ? 'ticker' : 'unknown';
}
function pairKey(left: number, right: number): string { return left < right ? `${left}:${right}` : `${right}:${left}`; }
function values<T>(map: Map<string, Set<T>>, key: string): Set<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<T>();
  map.set(key, created);
  return created;
}

function nearestMedianMinutes(left: number[], right: number[]): number | null {
  if (!left.length || !right.length) return null;
  const delays: number[] = [];
  let li = 0; let ri = 0;
  while (li < left.length && ri < right.length) {
    const delay = Math.abs(left[li] - right[ri]) / 60_000;
    if (delay <= 30) delays.push(delay);
    if (left[li] <= right[ri]) li += 1; else ri += 1;
  }
  return median(delays);
}

export function analyzeAccountNetwork(rawMentions: XMention[], options: Options): MacroNetworkAnalysis {
  const startedAt = performance.now();
  const maxCandidatePairs = Math.max(1_000, options.maxCandidatePairs ?? 300_000);
  const maxFeatureFanout = Math.max(10, options.maxFeatureFanout ?? 180);
  const bucketMs = Math.max(1, options.timeBucketMinutes ?? 5) * 60_000;

  const unique = new Map<string, XMention>();
  for (const mention of rawMentions) unique.set(mention.id, mention);
  const mentions = [...unique.values()];
  const byAuthor = new Map<string, XMention[]>();
  let firstTimestamp = Number.POSITIVE_INFINITY;
  for (const mention of mentions) {
    const handle = mention.author.handle.toLowerCase();
    const posts = byAuthor.get(handle);
    if (posts) posts.push(mention); else byAuthor.set(handle, [mention]);
    const timestamp = mention.createdAt?.getTime();
    if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp < firstTimestamp) firstTimestamp = timestamp;
  }
  for (const posts of byAuthor.values()) posts.sort((a, b) => (a.createdAt?.getTime() ?? Infinity) - (b.createdAt?.getTime() ?? Infinity));

  const handles = [...byAuthor.keys()];
  const handleId = new Map(handles.map((handle, index) => [handle, index]));
  const features = new Map<string, AccountFeatures>();
  const times = new Map<string, number[]>();
  for (const [handle, posts] of byAuthor) {
    features.set(handle, aggregateAccountFeatures(posts));
    times.set(handle, posts.map((post) => post.createdAt?.getTime()).filter((value): value is number => value !== undefined && Number.isFinite(value)));
  }

  const possiblePairCount = handles.length * (handles.length - 1) / 2;
  const candidates = new Set<string>();
  const addPair = (left: number, right: number) => {
    if (left === right || candidates.size >= maxCandidatePairs) return;
    candidates.add(pairKey(left, right));
  };
  const addGroups = (groups: Map<string, Set<number>>, fanout = maxFeatureFanout) => {
    for (const members of groups.values()) {
      if (members.size < 2 || members.size > fanout || candidates.size >= maxCandidatePairs) continue;
      const ids = [...members];
      for (let i = 0; i < ids.length && candidates.size < maxCandidatePairs; i += 1) {
        for (let j = i + 1; j < ids.length && candidates.size < maxCandidatePairs; j += 1) addPair(ids[i], ids[j]);
      }
    }
  };
  const inverted = (selector: (feature: AccountFeatures) => Set<string>) => {
    const index = new Map<string, Set<number>>();
    handles.forEach((handle, id) => { for (const item of selector(features.get(handle)!)) values(index, item).add(id); });
    return index;
  };

  // Strong, low-cardinality evidence first. This preserves the most useful
  // edges if the candidate budget is reached on a very large campaign.
  addGroups(inverted((feature) => feature.fingerprints), 500);
  addGroups(inverted((feature) => feature.contracts));
  addGroups(inverted((feature) => feature.links));
  addGroups(inverted((feature) => feature.tickers));
  addGroups(inverted((feature) => feature.hashtags));

  // Direct mentions are directional evidence and should never depend on text similarity.
  handles.forEach((handle, sourceId) => {
    for (const target of features.get(handle)!.mentions) {
      const targetId = handleId.get(target);
      if (targetId !== undefined) addPair(sourceId, targetId);
    }
  });

  // Rare-word blocking replaces the full all-pairs text comparison. Very
  // common words are ignored because they create giant, low-value buckets.
  const wordIndex = inverted((feature) => feature.words);
  const rareWordLimit = Math.max(8, Math.min(maxFeatureFanout, Math.ceil(handles.length * 0.08)));
  addGroups(wordIndex, rareWordLimit);

  // Temporal blocking compares accounts active in the same/adjacent windows.
  const timeBuckets = new Map<string, Set<number>>();
  handles.forEach((handle, id) => {
    for (const timestamp of times.get(handle)!) {
      const bucket = Math.floor(timestamp / bucketMs);
      values(timeBuckets, String(bucket)).add(id);
      values(timeBuckets, String(bucket - 1)).add(id);
    }
  });
  addGroups(timeBuckets, maxFeatureFanout);

  const edges: NetworkEdge[] = [];
  let peakText = 0;
  for (const key of candidates) {
    const [leftId, rightId] = key.split(':').map(Number);
    const left = handles[leftId]; const right = handles[rightId];
    const lf = features.get(left)!; const rf = features.get(right)!;
    const reasons: NetworkEdge['reasons'] = [];

    const textScore = jaccard(lf.words, rf.words);
    peakText = Math.max(peakText, textScore);
    if (textScore >= 0.25) reasons.push({ kind: 'text', score: textScore, detail: `${Math.round(textScore * 100)}% text overlap` });
    const fingerprints = sharedCount(lf.fingerprints, rf.fingerprints);
    const fingerprintScore = fingerprints > 0 ? 1 : 0;
    if (fingerprints) reasons.push({ kind: 'fingerprint', score: 1, detail: `${fingerprints} identical normalized posts` });
    const contractScore = jaccard(lf.contracts, rf.contracts);
    if (contractScore > 0) reasons.push({ kind: 'contracts', score: contractScore, detail: `${sharedCount(lf.contracts, rf.contracts)} shared contracts` });
    const linkScore = jaccard(lf.links, rf.links);
    if (linkScore > 0) reasons.push({ kind: 'links', score: linkScore, detail: `${sharedCount(lf.links, rf.links)} shared links` });
    const hashtagScore = jaccard(lf.hashtags, rf.hashtags);
    if (hashtagScore >= 0.25) reasons.push({ kind: 'hashtags', score: hashtagScore, detail: `${Math.round(hashtagScore * 100)}% hashtag overlap` });
    const tickerScore = jaccard(lf.tickers, rf.tickers);
    if (tickerScore > 0) reasons.push({ kind: 'tickers', score: tickerScore, detail: `${sharedCount(lf.tickers, rf.tickers)} shared tickers` });
    const mentionScore = lf.mentions.has(right) || rf.mentions.has(left) ? 1 : 0;
    if (mentionScore) reasons.push({ kind: 'mentions', score: 1, detail: 'direct account mention' });
    const medianDelay = nearestMedianMinutes(times.get(left)!, times.get(right)!);
    const timeScore = medianDelay === null ? 0 : clamp(1 - medianDelay / 30);
    if (timeScore >= 0.35) reasons.push({ kind: 'time', score: timeScore, detail: `median ${medianDelay!.toFixed(1)} min apart` });

    const weighted = fingerprintScore * 0.22 + textScore * 0.24 + contractScore * 0.14 + linkScore * 0.14 +
      tickerScore * 0.08 + hashtagScore * 0.06 + mentionScore * 0.07 + timeScore * 0.05;
    if (weighted >= 0.18 || mentionScore > 0 || fingerprintScore > 0) {
      edges.push({ source: left, target: right, weight: Math.round(clamp(weighted) * 100), reasons, averageDelayMinutes: medianDelay });
    }
  }

  const degree = new Map<string, NetworkEdge[]>();
  for (const edge of edges) {
    const left = degree.get(edge.source); if (left) left.push(edge); else degree.set(edge.source, [edge]);
    const right = degree.get(edge.target); if (right) right.push(edge); else degree.set(edge.target, [edge]);
  }
  const nodes: NetworkNode[] = handles.map((handle) => {
    const posts = byAuthor.get(handle)!; const author = posts[0].author; const timestamps = times.get(handle)!;
    const first = timestamps.length ? timestamps[0] : null; const last = timestamps.length ? timestamps[timestamps.length - 1] : null;
    const accountEdges = degree.get(handle) ?? [];
    const coordinationScore = accountEdges.length ? Math.round(accountEdges.reduce((sum, edge) => sum + edge.weight, 0) / accountEdges.length) : 0;
    const reach = Math.log10(Math.max(10, author.followers)) / 7;
    const engagement = posts.reduce((sum, post) => sum + post.engagement, 0);
    const cascade = clamp(accountEdges.length / Math.max(1, handles.length - 1));
    const influenceScore = Math.round(100 * clamp(reach * 0.45 + clamp(engagement / 500) * 0.25 + cascade * 0.3));
    const earliest = first !== null && Number.isFinite(firstTimestamp) && first - firstTimestamp <= 5 * 60_000;
    let role: AccountRole = 'participant';
    if (coordinationScore >= 65 && author.followers < 500) role = 'high-risk';
    else if (earliest && accountEdges.length >= 2) role = 'originator';
    else if (author.followers >= 25_000 || influenceScore >= 70) role = 'influencer';
    else if (accountEdges.length >= 3 || posts.length >= 2) role = 'amplifier';
    else if ([...features.get(handle)!.links].some((link) => link.includes('/communities/'))) role = 'community';
    return {
      handle, name: author.name, profileUrl: author.profileUrl, avatarUrl: author.avatarUrl,
      followers: author.followers, posts: posts.length,
      firstPostAt: first === null ? null : new Date(first), lastPostAt: last === null ? null : new Date(last),
       averageDelayMinutes: first === null ? null : median(timestamps.map((timestamp) => (timestamp - first) / 60_000)),
      influenceScore, coordinationScore, role,
      sharedContracts: features.get(handle)!.contracts.size, sharedLinks: features.get(handle)!.links.size,
    };
  }).sort((left, right) => right.influenceScore - left.influenceScore ||
    (left.averageDelayMinutes ?? Infinity) - (right.averageDelayMinutes ?? Infinity));

  const adjacency = new Map(handles.map((handle) => [handle, new Set<string>()]));
  for (const edge of edges) if (edge.weight >= 28) { adjacency.get(edge.source)!.add(edge.target); adjacency.get(edge.target)!.add(edge.source); }
  const seen = new Set<string>(); const components: string[][] = [];
  for (const handle of handles) {
    if (seen.has(handle)) continue;
    const stack = [handle]; const component: string[] = []; seen.add(handle);
    while (stack.length) {
      const current = stack.pop()!; component.push(current);
      for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    if (component.length >= 2) components.push(component);
  }

  const edgeByMember = new Map<string, NetworkEdge[]>();
  for (const edge of edges) {
    const left = edgeByMember.get(edge.source); if (left) left.push(edge); else edgeByMember.set(edge.source, [edge]);
    const right = edgeByMember.get(edge.target); if (right) right.push(edge); else edgeByMember.set(edge.target, [edge]);
  }
  const nodeByHandle = new Map(nodes.map((node) => [node.handle, node]));
  const clusters: AccountCluster[] = components.map((members, index) => {
    const memberSet = new Set(members); const internalMap = new Map<string, NetworkEdge>();
    for (const member of members) for (const edge of edgeByMember.get(member) ?? []) {
      if (memberSet.has(edge.source) && memberSet.has(edge.target)) internalMap.set(`${edge.source}:${edge.target}`, edge);
    }
    const internal = [...internalMap.values()]; const possible = members.length * (members.length - 1) / 2;
    const common = (key: 'contracts' | 'links' | 'hashtags') => {
      const counts = new Map<string, number>();
      for (const member of members) for (const value of features.get(member)![key]) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value]) => value);
    };
    const originator = members.map((handle) => nodeByHandle.get(handle)!).filter((node) => node.firstPostAt)
      .sort((left, right) => left.firstPostAt!.getTime() - right.firstPostAt!.getTime() || right.influenceScore - left.influenceScore)[0];
    return {
      id: `cluster-${index + 1}`, handles: members.sort(), size: members.length,
      density: possible ? internal.length / possible : 0,
      coordinationScore: internal.length ? Math.round(internal.reduce((sum, edge) => sum + edge.weight, 0) / internal.length) : 0,
      likelyOriginator: originator?.handle ?? null, commonContracts: common('contracts'), commonLinks: common('links'),
      commonHashtags: common('hashtags'), medianDelayMinutes: median(internal.map((edge) => edge.averageDelayMinutes).filter((value): value is number => value !== null)),
    };
  }).sort((left, right) => right.coordinationScore - left.coordinationScore || right.size - left.size);

  const networkDensity = possiblePairCount ? edges.length / possiblePairCount : 0;
  const coordinationScore = edges.length ? Math.round(clamp(edges.reduce((sum, edge) => sum + edge.weight, 0) / edges.length / 100 * 0.75 + Math.min(1, networkDensity * 10) * 0.25) * 100) : 0;
  const likelyOriginator = nodes.filter((node) => node.firstPostAt).sort((left, right) =>
    left.firstPostAt!.getTime() - right.firstPostAt!.getTime() || right.influenceScore - left.influenceScore)[0]?.handle ?? null;
  const timeline = [...mentions].sort((left, right) => (left.createdAt?.getTime() ?? Infinity) - (right.createdAt?.getTime() ?? Infinity)).slice(0, 80).map((mention) => ({
    id: mention.id, handle: mention.author.handle.toLowerCase(), createdAt: mention.createdAt,
    delayFromFirstMinutes: mention.createdAt && Number.isFinite(firstTimestamp) ? (mention.createdAt.getTime() - firstTimestamp) / 60_000 : null,
    url: mention.url, excerpt: mention.text.trim().slice(0, 180), context: contextFor(mention.text, options.address, options.symbol),
  }));
  const dated = timeline.map((event) => event.createdAt?.getTime()).filter((value): value is number => value !== undefined && Number.isFinite(value));
  const gaps = dated.slice(1).map((timestamp, index) => Math.max(0, (timestamp - dated[index]) / 60_000));

  return {
    nodeCount: nodes.length, edgeCount: edges.length, clusterCount: clusters.length, networkDensity,
    coordinationScore, organicScore: 100 - coordinationScore, likelyOriginator,
    medianPropagationDelayMinutes: median(gaps), copySimilarityPeak: peakText,
    candidatePairCount: candidates.size, possiblePairCount,
    pruningRatio: possiblePairCount ? 1 - candidates.size / possiblePairCount : 0,
    analysisMs: performance.now() - startedAt,
    nodes: nodes.slice(0, 60), edges: edges.sort((left, right) => right.weight - left.weight).slice(0, 120),
    clusters: clusters.slice(0, 12), timeline,
  };
}
