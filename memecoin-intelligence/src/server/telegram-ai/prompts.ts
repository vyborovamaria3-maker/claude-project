import type { TelegramAnalysisContext, TelegramMessageInput } from './schemas.js';

export const TELEGRAM_PROMPT_VERSION = 'intelligence-qwen-v2';

const systemPrompt = `You are the evidence-first intelligence analyst for a memecoin research platform.
Use only the supplied messages, structured features, deterministic graph and evidence. Never invent outside facts, identities, ownership, payments, wallet control or coordination.
When analysisMode is telegram_only, analyze Telegram only. When analysisMode is full_intelligence, reason across Telegram, X, market, price, on-chain and graph features supplied in intelligenceSnapshot.
Treat deterministic scores as observations to inspect, not truths to repeat. Look for disagreements between features, timing, sources and graph structure.
Graph edges marked copies/amplifies/shared_link are candidate relationships, not proof of common control. New discoveredRelationships must remain hypotheses unless multiple independent evidence items support them.
Perform the work in passes internally: observations -> actors -> graph -> manipulation -> temporal/market causality -> adversarial critique. Do not reveal chain-of-thought; return only concise conclusions and evidence references.
Every non-trivial claim, relationship, discovery, anomaly and risk must cite supplied evidence IDs whenever evidence exists. Never cite an ID that is not in the input.
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
    features: snapshot.features.slice(0, 220).map((feature) => ({
      key: feature.key,
      group: feature.group,
      value: feature.value,
      numericValue: feature.numericValue ?? null,
      confidence: feature.confidence,
      missing: feature.missing,
      note: feature.note ?? null,
    })),
    graph: {
      stats: snapshot.graph.stats,
      nodes: snapshot.graph.nodes.slice(0, 220).map((node) => ({ id: node.id, type: node.type, label: node.label, attributes: node.attributes })),
      edges: snapshot.graph.edges.slice(0, 500).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, confidence: edge.confidence, evidenceIds: edge.evidenceIds, attributes: edge.attributes })),
    },
    evidence: snapshot.evidence.slice(0, 180).map((entry) => ({ id: entry.id, platform: entry.platform, source: entry.source, timestamp: entry.timestamp ?? null, url: entry.url ?? null, text: entry.text.slice(0, 1_000) })),
    rawSummary: snapshot.rawSummary,
  };
}

export function buildTelegramPrompt(messages: TelegramMessageInput[], context: TelegramAnalysisContext = {}) {
  const compactMessages = messages.slice(0, 120).map((message) => ({
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
    links: message.links,
    text: message.text.slice(0, 4_000),
  }));
  const analysisContext = {
    tokenAddress: context.tokenAddress ?? null,
    symbol: context.symbol ?? null,
    tokenName: context.tokenName ?? null,
    windowStart: context.windowStart ?? null,
    windowEnd: context.windowEnd ?? null,
    analysisMode: context.analysisMode ?? 'telegram_only',
    intelligenceSnapshot: compactSnapshot(context),
  };
  const task = analysisContext.analysisMode === 'full_intelligence'
    ? 'Analyze the complete memecoin intelligence snapshot, explain actor/graph propagation, discover new evidence-backed relationships and challenge the deterministic scores.'
    : 'Analyze Telegram memecoin discussion and cross-channel relationships.';
  return { system: systemPrompt, user: JSON.stringify({ task, context: analysisContext, outputSchema: outputShape, messages: compactMessages }) };
}
