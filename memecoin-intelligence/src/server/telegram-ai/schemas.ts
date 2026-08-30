import { z } from 'zod';

const dateString = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'Invalid ISO date');
const confidence = z.number().min(0).max(1);
const severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const evidenceIds = z.array(z.string().min(1)).max(50);
const requiredEvidenceIds = z.array(z.string().min(1)).min(1).max(50);
const supportingFeatureKeys = z.array(z.string().min(1).max(160)).max(30);

export const telegramMessageSchema = z.object({
  id: z.string().trim().min(1).max(128), channelId: z.string().trim().min(1).max(128),
  channelUsername: z.string().trim().max(128).optional().nullable(), channelTitle: z.string().trim().max(256).optional().nullable(),
  senderId: z.string().trim().max(128).optional().nullable(), text: z.string().max(40_000), sentAt: dateString,
  editedAt: dateString.optional().nullable(), views: z.number().int().min(0).default(0), forwards: z.number().int().min(0).default(0), reactions: z.number().int().min(0).default(0),
  replyToMessageId: z.string().trim().max(128).optional().nullable(), links: z.array(z.string().url()).max(100).default([]), raw: z.record(z.string(), z.unknown()).optional(),
}).strict();

const intelligenceFeatureSchema = z.object({
  key: z.string().min(1).max(160), group: z.string().min(1).max(160), label: z.string().min(1).max(160),
  value: z.union([z.string().max(512), z.number(), z.null()]), numericValue: z.number().finite().optional().nullable(),
  source: z.enum(['derived', 'x', 'telegram', 'market', 'chain']), confidence, observedAt: dateString, missing: z.boolean(), note: z.string().max(1_000).optional(),
}).strict();
const intelligenceNodeSchema = z.object({ id: z.string().min(1).max(160), type: z.enum(['token', 'x_account', 'tg_channel', 'url', 'wallet', 'bundle']), label: z.string().min(1).max(1_000), attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict();
const intelligenceEdgeSchema = z.object({ id: z.string().min(1).max(160), source: z.string().min(1).max(160), target: z.string().min(1).max(160), type: z.enum(['mentions', 'calls', 'shared_link', 'copies', 'amplifies', 'trades', 'bundle_member', 'mentions_wallet']), confidence, evidenceIds, attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict();
const intelligenceEvidenceSchema = z.object({ id: z.string().min(1).max(160), platform: z.enum(['x', 'telegram']), source: z.string().min(1).max(512), text: z.string().max(40_000), timestamp: dateString.optional().nullable(), url: z.string().max(2_000).optional().nullable() }).strict();

export const intelligenceSnapshotSchema = z.object({
  snapshotId: z.string().min(1).max(160), version: z.string().min(1).max(80), graphVersion: z.string().min(1).max(80), mint: z.string().min(1).max(128),
  symbol: z.string().max(32).optional().nullable(), tokenName: z.string().max(128).optional().nullable(), createdAt: dateString,
  featureCount: z.number().int().min(0).max(1_000), missingFeatureCount: z.number().int().min(0).max(1_000), features: z.array(intelligenceFeatureSchema).max(300),
  graph: z.object({
    version: z.string().min(1).max(80), nodes: z.array(intelligenceNodeSchema).max(500), edges: z.array(intelligenceEdgeSchema).max(1_500),
    stats: z.object({ nodes: z.number().int().min(0), edges: z.number().int().min(0), xAccounts: z.number().int().min(0), tgChannels: z.number().int().min(0), wallets: z.number().int().min(0), bundles: z.number().int().min(0), socialWalletLinks: z.number().int().min(0), sharedLinks: z.number().int().min(0), copyEdges: z.number().int().min(0), amplificationEdges: z.number().int().min(0) }).strict(),
  }).strict(),
  evidence: z.array(intelligenceEvidenceSchema).max(300),
  rawSummary: z.object({
    xPosts: z.number().int().min(0), xRiskUniversePosts: z.number().int().min(0).optional(), telegramMessages: z.number().int().min(0), telegramMatchedBeforeLimit: z.number().int().min(0).optional(),
    trades: z.number().int().min(0), wallets: z.number().int().min(0), bundles: z.number().int().min(0), chainTruncated: z.boolean(), marketAvailable: z.boolean(), marketStale: z.boolean().optional(),
    originalFeatures: z.number().int().min(0).optional(), originalGraphNodes: z.number().int().min(0).optional(), originalGraphEdges: z.number().int().min(0).optional(), originalEvidence: z.number().int().min(0).optional(),
    qwenGraphNodes: z.number().int().min(0).optional(), qwenGraphEdges: z.number().int().min(0).optional(), qwenEvidence: z.number().int().min(0).optional(), qwenGraphCompacted: z.boolean().optional(),
  }).strict(),
}).strict();

export const telegramContextSchema = z.object({
  tokenAddress: z.string().trim().max(128).optional().nullable(), symbol: z.string().trim().max(32).optional().nullable(), tokenName: z.string().trim().max(128).optional().nullable(),
  windowStart: dateString.optional().nullable(), windowEnd: dateString.optional().nullable(), analysisMode: z.enum(['telegram_only', 'full_intelligence']).optional().default('telegram_only'),
  analysisRole: z.enum(['analyst', 'critic']).optional().default('analyst'), priorConclusion: z.string().max(6_000).optional().nullable(), intelligenceSnapshot: intelligenceSnapshotSchema.optional(),
}).strict().default({});

const discoveredRelationshipSchema = z.object({
  source: z.string().min(1).max(512), target: z.string().min(1).max(512), type: z.enum(['likely_originator', 'likely_amplifier', 'likely_coordinated', 'shared_campaign', 'narrative_source', 'possible_link', 'other']),
  confidence, status: z.enum(['hypothesis', 'supported', 'contradicted']), rationale: z.string().min(1).max(1_500), evidenceMessageIds: evidenceIds,
  supportingFeatureKeys: z.array(z.string().min(1).max(160)).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.evidenceMessageIds.length === 0 && value.supportingFeatureKeys.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A discovered relationship requires message evidence or supporting feature keys', path: ['supportingFeatureKeys'] });
});

const sourceAssessmentSchema = z.object({ currentSituation: z.string().min(1).max(2_000), interpretation: z.string().min(1).max(2_000), entryImpact: z.string().min(1).max(2_000), supportingFeatureKeys, confidence }).strict();
const entryAssessmentSchema = z.object({
  priceState: z.enum(['discounted_vs_signal', 'reasonable_vs_signal', 'stretched_vs_signal', 'overheated_vs_signal', 'unstable_vs_signal', 'unknown']),
  entryAction: z.enum(['strong_entry', 'consider', 'wait_confirmation', 'late_weak', 'avoid']), oneLineVerdict: z.string().min(1).max(1_500),
  whyNow: z.array(z.string().min(1).max(700)).max(12), alreadyPricedIn: z.array(z.string().min(1).max(700)).max(12), missingConfirmation: z.array(z.string().min(1).max(700)).max(12), invalidation: z.array(z.string().min(1).max(700)).max(12),
  supportingFeatureKeys: supportingFeatureKeys.optional(), evidenceMessageIds: evidenceIds.optional(), confidence,
}).strict();

export const telegramAiResultSchema = z.object({
  summary: z.string().min(1).max(4_000),
  sentiment: z.object({ label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive', 'mixed']), score: z.number().min(-1).max(1), confidence }).strict(),
  dominantIntent: z.enum(['discussion', 'promotion', 'warning', 'news', 'question', 'scam', 'mixed', 'unknown']),
  mentionedTokens: z.array(z.object({ address: z.string().max(128).optional().nullable(), symbol: z.string().max(32).optional().nullable(), name: z.string().max(128).optional().nullable(), confidence, evidenceMessageIds: evidenceIds }).strict()).max(100),
  entities: z.array(z.object({ type: z.enum(['account', 'channel', 'wallet', 'contract', 'token', 'website', 'telegram_link', 'person', 'organization', 'other']), value: z.string().min(1).max(512), normalizedValue: z.string().min(1).max(512), confidence, evidenceMessageIds: requiredEvidenceIds }).strict()).max(300),
  claims: z.array(z.object({ text: z.string().min(1).max(1_000), type: z.enum(['price_prediction', 'partnership', 'listing', 'airdrop', 'security', 'liquidity', 'ownership', 'performance', 'other']), confidence, verificationStatus: z.enum(['unverified', 'supported_in_messages', 'contradicted_in_messages']), evidenceMessageIds: requiredEvidenceIds }).strict()).max(200),
  relationships: z.array(z.object({ source: z.string().min(1).max(512), target: z.string().min(1).max(512), type: z.enum(['mentions', 'reposts', 'copies', 'amplifies', 'shares_link', 'shares_contract', 'responds_to', 'likely_source_of', 'other']), confidence, rationale: z.string().min(1).max(1_000), evidenceMessageIds: requiredEvidenceIds }).strict()).max(300),
  coordinationSignals: z.array(z.object({ type: z.enum(['near_simultaneous_posts', 'copied_text', 'shared_links', 'shared_contracts', 'repeated_narrative', 'synchronized_calls', 'cross_channel_amplification', 'other']), severity, confidence, explanation: z.string().min(1).max(1_500), evidenceMessageIds: requiredEvidenceIds }).strict()).max(100),
  campaignHypothesis: z.object({ label: z.enum(['organic', 'mixed', 'coordinated', 'insufficient_data']), confidence, likelyOriginators: z.array(z.string().max(512)).max(50), amplifiers: z.array(z.string().max(512)).max(100), narrative: z.string().max(3_000), evidenceMessageIds: evidenceIds }).strict(),
  risks: z.array(z.object({ type: z.enum(['misinformation', 'scam', 'impersonation', 'coordinated_promotion', 'liquidity_risk', 'security_claim', 'market_manipulation', 'unknown']), severity, confidence, explanation: z.string().min(1).max(1_500), evidenceMessageIds: requiredEvidenceIds }).strict()).max(100),
  featureAssessments: z.array(z.object({ featureKey: z.string().min(1).max(160), assessment: z.enum(['supportive', 'neutral', 'concerning', 'insufficient_data']), importance: confidence, confidence, explanation: z.string().min(1).max(1_000), evidenceMessageIds: evidenceIds }).strict()).max(120).optional().default([]),
  discoveredRelationships: z.array(discoveredRelationshipSchema).max(150).optional().default([]),
  anomalies: z.array(z.object({ type: z.string().min(1).max(120), severity, confidence, explanation: z.string().min(1).max(1_500), relatedFeatureKeys: z.array(z.string().max(160)).max(30).default([]), evidenceMessageIds: evidenceIds }).strict()).max(100).optional().default([]),
  contradictions: z.array(z.object({ statement: z.string().min(1).max(1_500), confidence, evidenceMessageIds: evidenceIds }).strict()).max(60).optional().default([]),
  whatWouldChangeConclusion: z.array(z.string().min(1).max(700)).max(20).optional().default([]),
  finalIntelligence: z.object({ marketState: z.string().min(1).max(1_500), socialState: z.string().min(1).max(1_500), manipulationAssessment: z.string().min(1).max(1_500), bullCase: z.string().min(1).max(1_500), bearCase: z.string().min(1).max(1_500), unknowns: z.array(z.string().min(1).max(700)).max(30), confidence }).strict().optional(),
  sourceAssessments: z.object({ x: sourceAssessmentSchema, telegram: sourceAssessmentSchema, chain: sourceAssessmentSchema }).strict().optional(),
  entryAssessment: entryAssessmentSchema.optional(), reasoningSummary: z.array(z.string().min(1).max(700)).min(1).max(20), overallConfidence: confidence,
}).strict();

export const telegramAnalyzeRequestSchema = z.object({ messages: z.array(telegramMessageSchema).min(1).max(500), context: telegramContextSchema.optional(), persist: z.boolean().default(false) }).strict();
export const telegramEnqueueRequestSchema = telegramAnalyzeRequestSchema.extend({ persist: z.literal(true).default(true) });

export type TelegramMessageInput = z.infer<typeof telegramMessageSchema>;
export type TelegramAnalysisContext = z.infer<typeof telegramContextSchema>;
export type TelegramAiResult = z.infer<typeof telegramAiResultSchema>;
