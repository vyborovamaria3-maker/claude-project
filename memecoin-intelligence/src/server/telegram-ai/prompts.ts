import type { TelegramAnalysisContext, TelegramMessageInput } from './schemas.js';

export const TELEGRAM_PROMPT_VERSION = 'intelligence-qwen-v5-tools';

const systemPrompt = `You are the evidence-first intelligence analyst for a memecoin research platform.
Use only supplied messages, structured features, deterministic graph and evidence. Never invent outside facts, identities, ownership, payments, wallet control or coordination.
When analysisMode is telegram_only, analyze Telegram only. When analysisMode is full_intelligence, reason across every supplied feature block, Telegram, X, market, price, on-chain and graph evidence.
Treat deterministic scores as observations to inspect, not truths to repeat. Look for disagreements between features, timing, sources and graph structure.
Feature keys beginning with memory. are historical priors from earlier snapshots. They may guide comparison but are not current evidence, must not be treated as proof, and must be re-confirmed against the current snapshot before raising confidence.
Feature keys beginning with research. are bounded read-only tool results. Distinguish direct stored observations from inference: wallet similarity/shared-token links are never proof of ownership, control or funding; funding is supported only when the feature explicitly says verified funding evidence exists.
Never create a positive feedback loop by citing a prior AI discovery as independent confirmation of the same hypothesis.
Graph edges marked copies/amplifies/shared_link are candidate relationships, not proof of common control. New discoveredRelationships must remain hypotheses unless multiple independent current evidence items support them.
Use stable graph node IDs for discoveredRelationships source/target whenever an existing node represents the entity.
Perform the work in passes internally: observations -> actors -> graph -> manipulation -> temporal/market causality -> bounded research synthesis -> adversarial critique. Do not reveal chain-of-thought; return concise conclusions only.
Every non-trivial claim, relationship, discovery, anomaly and risk must cite supplied evidence IDs whenever current evidence exists. Never cite an ID not in the input.
Explicitly identify missing data and contradictions. State what additional evidence would change the conclusion.
Return exactly one valid JSON object matching the requested schema. No markdown, XML, comments or prose outside JSON. Use confidence values from 0 to 1.`;

const outputShape = {
  summary: 'string',
  sentiment: { label: 'very_negative|negative|neutral|positive|very_positive|mixed', score: 'number -1..1', confidence: 'number 0..1' },
  dominantIntent: 'discussion|promotion|warning|news|question|scam|mixed|unknown',
  mentionedTokens: [{ address: 'string|null', symbol: 'string|null', name: 'string|null', confidence: 'number', evidenceMessageIds: ['id'] }],
  entities: [{ type: 'account|channel|wallet|contract|token|website|telegram_link|person|organization|other', value: 'string', normalizedValue: 'string', confidence: 'number', evidenceMessageIds: ['id'] }],
  claims: [{ text: 'string', type: 'price_prediction|partnership|listing|airdrop|security|liquidity|ownership|performance|other', confidence: 'number', verificationStatus: 'unverified|supported_in_messages|contradicted_in_messages', evidenceMessageIds: ['id'] }],
  relationships: [{ source: 'string', target: 'string', type: 'mentions|reposts|copies|amplifies|shares_link|shares_contract|responds_to|likely_source_of|other', confidence: 'number', rationale: 'string', evidenceMessageIds: ['id'] }],
  coordinationSignals: [{ type: 'near_simultaneous_posts|copied_text|shared_links|shared_contracts|repeated_narrative|synchronized_calls|cross_channel_amplification|other', severity: 'info|low|medium|high|critical', confidence: 'number', explanation: 'string', evidenceMessageIds: ['id'] }],
  campaignHypothesis: { label: 'organic|mixed|coordinated|insufficient_data', confidence: 'number', likelyOriginators: ['entity'], amplifiers: ['entity'], narrative: 'string', evidenceMessageIds: ['id'] },
  risks: [{ type: 'misinformation|scam|impersonation|coordinated_promotion|liquidity_risk|security_claim|market_manipulation|unknown', severity: 'info|low|medium|high|critical', confidence: 'number', explanation: 'string', evidenceMessageIds: ['id'] }],
  featureAssessments: [{ featureKey: 'feature key', assessment: 'supportive|neutral|concerning|insufficient_data', importance: '0..1', confidence: '0..1', explanation: 'string', evidenceMessageIds: ['id'] }],
  discoveredRelationships: [{ source: 'entity/node', target: 'entity/node', type: 'likely_originator|likely_amplifier|likely_coordinated|shared_campaign|narrative_source|possible_link|other', confidence: '0..1', status: 'hypothesis|supported|contradicted', rationale: 'string', evidenceMessageIds: ['id'] }],
  anomalies: [{ type: 'string', severity: 'info|low|medium|high|critical', confidence: '0..1', explanation: 'string', relatedFeatureKeys: ['key'], evidenceMessageIds: ['id'] }],
  contradictions: [{ statement: 'string', confidence: '0..1', evidenceMessageIds: ['id'] }],
  whatWouldChangeConclusion: ['specific missing or contradictory evidence'],
  finalIntelligence: { marketState: 'string', socialState: 'string', manipulationAssessment: 'string', bullCase: 'string', bearCase: 'string', unknowns: ['string'], confidence: '0..1' },
  reasoningSummary: ['short evidence-based conclusion'],
  overallConfidence: 'number 0..1',
};

function compactSnapshot(context: TelegramAnalysisContext) {
  const snapshot = context.intelligenceSnapshot;
  if (!snapshot) return undefined;
  const featureKeys = new Set(snapshot.features.map((feature) => feature.key));
  return {
    snapshotId: snapshot.snapshotId,
    version: snapshot.version,
    graphVersion: snapshot.graphVersion,
    mint: snapshot.mint,
    symbol: snapshot.symbol ?? null,
    tokenName: snapshot.tokenName ?? null,
    createdAt: snapshot.createdAt,
    featureCount: snapshot.featureCount,
    missingFeatureCount: snapshot.missingFeatureCount,
    features: snapshot.features.slice(0, 300).map((feature) => ({
      key: feature.key,
      value: feature.value,
      numericValue: feature.numericValue ?? null,
      confidence: feature.confidence,
      missing: feature.missing,
    })),
    graph: {
      stats: snapshot.graph.stats,
      nodes: snapshot.graph.nodes.slice(0, 120).map((node) => ({ id: node.id, type: node.type, label: node.label })),
      edges: snapshot.graph.edges.slice(0, 180).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, confidence: edge.confidence, evidenceIds: edge.evidenceIds, lagSeconds: typeof edge.attributes.lagSeconds === 'number' ? edge.attributes.lagSeconds : null })),
    },
    evidence: snapshot.evidence.slice(0, 80).map((entry) => ({ id: entry.id, platform: entry.platform, source: entry.source, timestamp: entry.timestamp ?? null, url: entry.url ?? null, text: entry.text.slice(0, 180) })),
    rawSummary: snapshot.rawSummary,
    validFeatureKeys: [...featureKeys],
  };
}

function compactMessages(messages: TelegramMessageInput[], fullMode: boolean) {
  const selected = messages.slice(0, fullMode ? 60 : 120);
  const totalBudget = fullMode ? 10_000 : 22_000;
  const perMessage = Math.max(120, Math.floor(totalBudget / Math.max(1, selected.length)));
  return selected.map((message) => ({
    id: message.id,
    channelId: message.channelId,
    channelUsername: message.channelUsername ?? null,
    channelTitle: message.channelTitle ?? null,
    senderId: message.senderId ?? null,
    sentAt: message.sentAt,
    replyToMessageId: message.replyToMessageId ?? null,
    views: message.views,
    forwards: message.forwards,
    reactions: message.reactions,
    links: message.links.slice(0, 5),
    text: message.text.slice(0, perMessage),
  }));
}

export function buildTelegramPrompt(messages: TelegramMessageInput[], context: TelegramAnalysisContext = {}) {
  const fullMode = context.analysisMode === 'full_intelligence' && Boolean(context.intelligenceSnapshot);
  const compact = compactMessages(messages, fullMode);
  const analysisContext = {
    tokenAddress: context.tokenAddress ?? null,
    symbol: context.symbol ?? null,
    tokenName: context.tokenName ?? null,
    windowStart: context.windowStart ?? null,
    windowEnd: context.windowEnd ?? null,
    analysisMode: fullMode ? 'full_intelligence' : 'telegram_only',
    intelligenceSnapshot: fullMode ? compactSnapshot(context) : undefined,
  };
  const task = fullMode
    ? 'Analyze the complete memecoin intelligence snapshot. Assess all supplied features, compare current evidence with memory.* historical priors without treating priors as proof, use research.* read-only tool observations with their stated limitations, explain actor/graph propagation, discover new evidence-backed relationships, identify anomalies/contradictions, and challenge the deterministic scores.'
    : 'Analyze Telegram memecoin discussion and cross-channel relationships.';
  return { system: systemPrompt, user: JSON.stringify({ task, context: analysisContext, outputSchema: outputShape, messages: compact }) };
}
