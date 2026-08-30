import type { TelegramAnalysisContext, TelegramMessageInput } from './schemas.js';

export const TELEGRAM_PROMPT_VERSION = 'intelligence-qwen-v10-grounded-entry';

const systemPrompt = `You are the evidence-first intelligence analyst for a memecoin research platform.
Use only supplied messages, structured features, deterministic graph and evidence. Never invent outside facts, identities, ownership, payments, wallet control or coordination.
When analysisMode is telegram_only, analyze Telegram only. When analysisMode is full_intelligence, reason across every supplied feature block, Telegram, X, market, price, on-chain and graph evidence.
Treat deterministic scores as observations to inspect, not truths to repeat. Look for disagreements between features, timing, sources and graph structure.
Feature keys beginning with memory. are historical priors from earlier snapshots. They may guide comparison but are not current evidence, must not be treated as proof, and must be re-confirmed against the current snapshot before raising confidence.
Feature keys beginning with research. are bounded read-only tool results. Wallet similarity/shared-token links are never proof of identity, control, funding or causality. Collector-stored explicit funding evidence is a lead; transaction/signature evidence can raise confidence but is not independently chain-verified by this agent.
When discoveredRelationships depend on memory.* or research.* data, include those exact keys in supportingFeatureKeys and keep the relationship a hypothesis unless independent current evidence supports it.
Never create a positive feedback loop by citing a prior AI discovery as independent confirmation of the same hypothesis.
Graph edges marked copies/amplifies/shared_link are candidate relationships, not proof of common control. New discoveredRelationships must remain hypotheses unless multiple independent current evidence items support them.
Use stable graph node IDs for discoveredRelationships source/target whenever an existing node represents the entity.
If analysisRole is critic, independently try to falsify priorConclusion using the supplied facts. Do not assume the analyst is correct. Identify unsupported leaps, alternative explanations, missing evidence and contradictions. Audit the prior entryAssessment and sourceAssessments explicitly when they are present. Do not reveal hidden reasoning; return the same structured schema with concise evidence-based conclusions.
If analysisRole is analyst, perform the work in passes internally: observations -> actors -> graph -> manipulation -> temporal/market causality -> entry timing -> source-specific synthesis -> bounded research synthesis -> adversarial critique.
For full_intelligence, explicitly separate token quality from entry timing. A strong token can still be a bad or late entry after a vertical move. Assess whether the CURRENT price/moment is discounted, reasonable, stretched, overheated or unstable relative to supplied evidence, not relative to an invented intrinsic value.
Never call a token intrinsically cheap or expensive without valuation evidence. A sharp price drop is not automatically a discount; use unstable_vs_signal when falling price has not stabilized or seller/on-chain evidence remains weak. If fresh market/price evidence is missing or rawSummary.marketStale is true, set entryAssessment.priceState to unknown and do not use stale 1h/24h movement or liquidity to call the current entry cheap, expensive, overheated or stable.
For entryAssessment, compare price movement/overextension with social timing, organic-vs-manipulated attention, Telegram call quality, smart-wallet behavior, seller pressure, wash/bundle risk, liquidity, source agreement and data coverage. Explain what is already priced in and what evidence is still missing. supportingFeatureKeys is mandatory and must contain exact visible feature keys supporting the entry conclusion; evidenceMessageIds may additionally cite supplied evidence IDs.
For sourceAssessments, produce a separate evidence-based human interpretation for X, Telegram and blockchain. Each source assessment must explain what is happening now, what it means, and how that source changes the current entry thesis. Do not merely restate scores. supportingFeatureKeys must contain only exact feature keys supplied in intelligenceSnapshot.validFeatureKeys; use an empty list when that source has no valid supporting feature and clearly mark it as insufficient data.
In full_intelligence you MUST return entryAssessment and all three sourceAssessments (x, telegram, chain). Missing source data is represented as insufficient/unknown with low confidence, never by omitting the block and never by inventing facts.
Do not issue personalized financial instructions or position sizing. entryAction is an analytical status for the observed setup, not a command to the user.
Every non-trivial claim, relationship, discovery, anomaly and risk must cite supplied evidence IDs whenever current evidence exists. Never cite an ID not in the input.
Explicitly identify missing data and contradictions. State what additional evidence would change the conclusion.
For human-facing narrative fields write in clear Russian. Keep JSON keys and enum values exactly as specified in English.
Return exactly one valid JSON object matching the requested schema. No markdown, XML, comments or prose outside JSON. Use confidence values from 0 to 1.`;

const sourceAssessmentShape = {
  currentSituation: 'Russian plain-language description of what is happening now in this source',
  interpretation: 'Russian evidence-based interpretation; explain quality, not just quantity',
  entryImpact: 'Russian explanation of how this source supports, weakens or fails to confirm the current entry thesis',
  supportingFeatureKeys: ['exact visible feature key, or empty only when source has no evidence'],
  confidence: '0..1',
};

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
  discoveredRelationships: [{ source: 'entity/node', target: 'entity/node', type: 'likely_originator|likely_amplifier|likely_coordinated|shared_campaign|narrative_source|possible_link|other', confidence: '0..1', status: 'hypothesis|supported|contradicted', rationale: 'string', evidenceMessageIds: ['id'], supportingFeatureKeys: ['memory.* or research.* key when used'] }],
  anomalies: [{ type: 'string', severity: 'info|low|medium|high|critical', confidence: '0..1', explanation: 'string', relatedFeatureKeys: ['key'], evidenceMessageIds: ['id'] }],
  contradictions: [{ statement: 'string', confidence: '0..1', evidenceMessageIds: ['id'] }],
  whatWouldChangeConclusion: ['specific missing or contradictory evidence'],
  finalIntelligence: { marketState: 'string', socialState: 'string', manipulationAssessment: 'string', bullCase: 'string', bearCase: 'string', unknowns: ['string'], confidence: '0..1' },
  sourceAssessments: { x: sourceAssessmentShape, telegram: sourceAssessmentShape, chain: sourceAssessmentShape },
  entryAssessment: {
    priceState: 'discounted_vs_signal|reasonable_vs_signal|stretched_vs_signal|overheated_vs_signal|unstable_vs_signal|unknown',
    entryAction: 'strong_entry|consider|wait_confirmation|late_weak|avoid',
    oneLineVerdict: 'Russian plain-language sentence explaining the current entry and why',
    whyNow: ['evidence-based reasons supporting the current setup'],
    alreadyPricedIn: ['specific evidence suggesting part of the move is already reflected'],
    missingConfirmation: ['specific evidence still needed before confidence should rise'],
    invalidation: ['specific observable developments that would break the entry thesis'],
    supportingFeatureKeys: ['at least one exact visible feature key'],
    evidenceMessageIds: ['optional supplied evidence id'],
    confidence: '0..1',
  },
  reasoningSummary: ['short evidence-based conclusion'],
  overallConfidence: 'number 0..1',
};

function compactFeatures(context: TelegramAnalysisContext) {
  const features = context.intelligenceSnapshot?.features ?? [];
  const core = features.filter((feature) => !feature.key.startsWith('memory.') && !feature.key.startsWith('research.'));
  const research = features.filter((feature) => feature.key.startsWith('research.'));
  const memory = features.filter((feature) => feature.key.startsWith('memory.'));
  const selected = [...core];
  let remainingChars = 12_000;
  for (const feature of [...research, ...memory]) {
    const cost = feature.key.length + String(feature.value ?? '').length + 48;
    if (cost > remainingChars) continue;
    selected.push(feature);
    remainingChars -= cost;
  }
  return selected.slice(0, 300);
}

export function promptVisibleFeatureKeys(context: TelegramAnalysisContext) {
  return new Set(compactFeatures(context).map((feature) => feature.key));
}

function compactSnapshot(context: TelegramAnalysisContext) {
  const snapshot = context.intelligenceSnapshot;
  if (!snapshot) return undefined;
  const compactedFeatures = compactFeatures(context);
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
    features: compactedFeatures.map((feature) => ({ key: feature.key, value: feature.value, numericValue: feature.numericValue ?? null, confidence: feature.confidence, missing: feature.missing })),
    omittedContextFeatureCount: Math.max(0, snapshot.features.length - compactedFeatures.length),
    graph: {
      stats: snapshot.graph.stats,
      nodes: snapshot.graph.nodes.slice(0, 120).map((node) => ({ id: node.id, type: node.type, label: node.label })),
      edges: snapshot.graph.edges.slice(0, 180).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, confidence: edge.confidence, evidenceIds: edge.evidenceIds, lagSeconds: typeof edge.attributes.lagSeconds === 'number' ? edge.attributes.lagSeconds : null })),
    },
    evidence: snapshot.evidence.slice(0, 80).map((entry) => ({ id: entry.id, platform: entry.platform, source: entry.source, timestamp: entry.timestamp ?? null, url: entry.url ?? null, text: entry.text.slice(0, 180) })),
    rawSummary: snapshot.rawSummary,
    validFeatureKeys: compactedFeatures.map((feature) => feature.key),
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
  const analysisRole = context.analysisRole ?? 'analyst';
  const analysisContext = {
    tokenAddress: context.tokenAddress ?? null,
    symbol: context.symbol ?? null,
    tokenName: context.tokenName ?? null,
    windowStart: context.windowStart ?? null,
    windowEnd: context.windowEnd ?? null,
    analysisMode: fullMode ? 'full_intelligence' : 'telegram_only',
    analysisRole,
    priorConclusion: analysisRole === 'critic' ? context.priorConclusion ?? null : null,
    intelligenceSnapshot: fullMode ? compactSnapshot(context) : undefined,
  };
  const task = analysisRole === 'critic'
    ? 'Independently audit and try to falsify the prior conclusion. Use only supplied evidence/features, identify unsupported leaps and alternative explanations, downgrade claims that are not independently supported, and state what survives the critique. In full_intelligence explicitly audit entryAssessment and each sourceAssessments block.'
    : fullMode
      ? 'Analyze the complete memecoin intelligence snapshot. Assess supplied core features, compare current evidence with memory.* priors without treating priors as proof, use research.* observations with stated limitations, discover evidence-backed relationships, identify anomalies/contradictions, challenge deterministic scores, return all sourceAssessments, and return a grounded entryAssessment separating token strength from current entry timing.'
      : 'Analyze Telegram memecoin discussion and cross-channel relationships.';
  return { system: systemPrompt, user: JSON.stringify({ task, context: analysisContext, outputSchema: outputShape, messages: compact }) };
}
