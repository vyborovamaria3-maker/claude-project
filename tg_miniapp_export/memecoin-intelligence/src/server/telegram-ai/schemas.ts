import { z } from 'zod';

const dateString = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'Invalid ISO date');

export const telegramMessageSchema = z.object({
  id: z.string().trim().min(1).max(128),
  channelId: z.string().trim().min(1).max(128),
  channelUsername: z.string().trim().max(128).optional().nullable(),
  channelTitle: z.string().trim().max(256).optional().nullable(),
  senderId: z.string().trim().max(128).optional().nullable(),
  text: z.string().max(40_000),
  sentAt: dateString,
  editedAt: dateString.optional().nullable(),
  views: z.number().int().min(0).default(0),
  forwards: z.number().int().min(0).default(0),
  reactions: z.number().int().min(0).default(0),
  replyToMessageId: z.string().trim().max(128).optional().nullable(),
  links: z.array(z.string().url()).max(100).default([]),
  raw: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const telegramContextSchema = z.object({
  tokenAddress: z.string().trim().max(128).optional().nullable(),
  symbol: z.string().trim().max(32).optional().nullable(),
  tokenName: z.string().trim().max(128).optional().nullable(),
  windowStart: dateString.optional().nullable(),
  windowEnd: dateString.optional().nullable(),
}).strict().default({});

const evidenceIds = z.array(z.string().min(1)).max(50);
const requiredEvidenceIds = z.array(z.string().min(1)).min(1).max(50);
const confidence = z.number().min(0).max(1);
const severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);

export const telegramAiResultSchema = z.object({
  summary: z.string().min(1).max(4_000),
  sentiment: z.object({
    label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive', 'mixed']),
    score: z.number().min(-1).max(1),
    confidence,
  }).strict(),
  dominantIntent: z.enum(['discussion', 'promotion', 'warning', 'news', 'question', 'scam', 'mixed', 'unknown']),
  mentionedTokens: z.array(z.object({
    address: z.string().max(128).optional().nullable(),
    symbol: z.string().max(32).optional().nullable(),
    name: z.string().max(128).optional().nullable(),
    confidence,
    evidenceMessageIds: evidenceIds,
  }).strict()).max(100),
  entities: z.array(z.object({
    type: z.enum(['account', 'channel', 'wallet', 'contract', 'token', 'website', 'telegram_link', 'person', 'organization', 'other']),
    value: z.string().min(1).max(512),
    normalizedValue: z.string().min(1).max(512),
    confidence,
    evidenceMessageIds: requiredEvidenceIds,
  }).strict()).max(300),
  claims: z.array(z.object({
    text: z.string().min(1).max(1_000),
    type: z.enum(['price_prediction', 'partnership', 'listing', 'airdrop', 'security', 'liquidity', 'ownership', 'performance', 'other']),
    confidence,
    verificationStatus: z.enum(['unverified', 'supported_in_messages', 'contradicted_in_messages']),
    evidenceMessageIds: requiredEvidenceIds,
  }).strict()).max(200),
  relationships: z.array(z.object({
    source: z.string().min(1).max(512),
    target: z.string().min(1).max(512),
    type: z.enum(['mentions', 'reposts', 'copies', 'amplifies', 'shares_link', 'shares_contract', 'responds_to', 'likely_source_of', 'other']),
    confidence,
    rationale: z.string().min(1).max(1_000),
    evidenceMessageIds: requiredEvidenceIds,
  }).strict()).max(300),
  coordinationSignals: z.array(z.object({
    type: z.enum(['near_simultaneous_posts', 'copied_text', 'shared_links', 'shared_contracts', 'repeated_narrative', 'synchronized_calls', 'cross_channel_amplification', 'other']),
    severity,
    confidence,
    explanation: z.string().min(1).max(1_500),
    evidenceMessageIds: requiredEvidenceIds,
  }).strict()).max(100),
  campaignHypothesis: z.object({
    label: z.enum(['organic', 'mixed', 'coordinated', 'insufficient_data']),
    confidence,
    likelyOriginators: z.array(z.string().max(512)).max(50),
    amplifiers: z.array(z.string().max(512)).max(100),
    narrative: z.string().max(3_000),
    evidenceMessageIds: evidenceIds,
  }).strict(),
  risks: z.array(z.object({
    type: z.enum(['misinformation', 'scam', 'impersonation', 'coordinated_promotion', 'liquidity_risk', 'security_claim', 'market_manipulation', 'unknown']),
    severity,
    confidence,
    explanation: z.string().min(1).max(1_500),
    evidenceMessageIds: requiredEvidenceIds,
  }).strict()).max(100),
  reasoningSummary: z.array(z.string().min(1).max(700)).min(1).max(20),
  overallConfidence: confidence,
}).strict();

export const telegramAnalyzeRequestSchema = z.object({
  messages: z.array(telegramMessageSchema).min(1).max(500),
  context: telegramContextSchema.optional(),
  persist: z.boolean().default(false),
}).strict();

export const telegramEnqueueRequestSchema = telegramAnalyzeRequestSchema.extend({
  persist: z.literal(true).default(true),
});

export type TelegramMessageInput = z.infer<typeof telegramMessageSchema>;
export type TelegramAnalysisContext = z.infer<typeof telegramContextSchema>;
export type TelegramAiResult = z.infer<typeof telegramAiResultSchema>;
