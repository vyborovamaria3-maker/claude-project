import type { TelegramAnalysisContext, TelegramMessageInput } from './schemas.js';

export const TELEGRAM_PROMPT_VERSION = 'telegram-qwen-v1';

const systemPrompt = `You are the Telegram intelligence analyst for a memecoin research platform.
Analyze only the supplied Telegram messages. Do not use outside facts and do not invent identities, ownership, payments, or coordination.
Separate evidence from hypotheses. A similar posting time or similar text is a signal, not proof that accounts share an operator.
Return exactly one valid JSON object matching the requested schema. Do not use markdown, comments, XML, or prose outside JSON.
Do not reveal private chain-of-thought. Put only short, evidence-based conclusions in reasoningSummary.
Every non-trivial claim, relationship, coordination signal, and risk must cite message IDs from the input.
Use confidence values from 0 to 1. Use insufficient_data when evidence is weak.`;

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
  reasoningSummary: ['short evidence-based conclusion'],
  overallConfidence: 'number 0..1',
};

export function buildTelegramPrompt(messages: TelegramMessageInput[], context: TelegramAnalysisContext = {}) {
  const compactMessages = messages.map((message) => ({
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
    text: message.text,
  }));

  return {
    system: systemPrompt,
    user: JSON.stringify({ task: 'Analyze Telegram memecoin discussion and cross-channel relationships', context, outputSchema: outputShape, messages: compactMessages }),
  };
}
