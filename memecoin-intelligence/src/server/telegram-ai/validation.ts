import { promptVisibleFeatureKeys } from './prompts.js';
import type { TelegramAiResult, TelegramAnalysisContext, TelegramMessageInput } from './schemas.js';

function isFullIntelligence(context: TelegramAnalysisContext) {
  return context.analysisMode === 'full_intelligence' && Boolean(context.intelligenceSnapshot);
}

function entryGroundingKeys(context: TelegramAnalysisContext) {
  const visible = [...promptVisibleFeatureKeys(context)];
  const preferred = visible.filter((key) =>
    key.startsWith('scores.')
    || key.startsWith('cross_platform_timing.')
    || key.startsWith('price_event_evidence.')
    || key.toLowerCase().includes('liquidity')
    || key.toLowerCase().includes('wallet'),
  );
  return (preferred.length ? preferred : visible).slice(0, 6);
}

export function groundMockFullIntelligence(
  result: TelegramAiResult,
  context: TelegramAnalysisContext,
): TelegramAiResult {
  if (!isFullIntelligence(context) || !result.entryAssessment) return result;
  if ((result.entryAssessment.supportingFeatureKeys ?? []).length > 0) return result;
  const supportingFeatureKeys = entryGroundingKeys(context);
  return {
    ...result,
    entryAssessment: {
      ...result.entryAssessment,
      supportingFeatureKeys,
      evidenceMessageIds: result.entryAssessment.evidenceMessageIds ?? [],
    },
  };
}

export function validateTelegramAiResult(
  result: TelegramAiResult,
  messages: TelegramMessageInput[],
  context: TelegramAnalysisContext,
): TelegramAiResult {
  if (isFullIntelligence(context)) {
    if (!result.entryAssessment) {
      throw new Error('Qwen full_intelligence result is missing entryAssessment');
    }
    if (!result.sourceAssessments?.x || !result.sourceAssessments.telegram || !result.sourceAssessments.chain) {
      throw new Error('Qwen full_intelligence result is missing one or more sourceAssessments');
    }
    if (!(result.entryAssessment.supportingFeatureKeys?.length)) {
      throw new Error('Qwen full_intelligence entryAssessment is missing supportingFeatureKeys');
    }
  }

  const allowedEvidence = new Set(messages.map((message) => message.id));
  for (const evidence of context.intelligenceSnapshot?.evidence ?? []) allowedEvidence.add(evidence.id);
  const evidenceGroups: string[][] = [
    ...result.mentionedTokens.map((entry) => entry.evidenceMessageIds),
    ...result.entities.map((entry) => entry.evidenceMessageIds),
    ...result.claims.map((entry) => entry.evidenceMessageIds),
    ...result.relationships.map((entry) => entry.evidenceMessageIds),
    ...result.coordinationSignals.map((entry) => entry.evidenceMessageIds),
    result.campaignHypothesis.evidenceMessageIds,
    ...result.risks.map((entry) => entry.evidenceMessageIds),
    ...result.featureAssessments.map((entry) => entry.evidenceMessageIds),
    ...result.discoveredRelationships.map((entry) => entry.evidenceMessageIds),
    ...result.anomalies.map((entry) => entry.evidenceMessageIds),
    ...result.contradictions.map((entry) => entry.evidenceMessageIds),
    ...(result.entryAssessment ? [result.entryAssessment.evidenceMessageIds ?? []] : []),
  ];
  const unknownEvidence = [...new Set(evidenceGroups.flat().filter((id) => !allowedEvidence.has(id)))];
  if (unknownEvidence.length) {
    throw new Error(`Qwen cited unknown evidence IDs: ${unknownEvidence.slice(0, 10).join(', ')}`);
  }

  const visibleFeatureKeys = promptVisibleFeatureKeys(context);
  if (visibleFeatureKeys.size) {
    const sourceFeatureKeys = result.sourceAssessments
      ? [
          ...result.sourceAssessments.x.supportingFeatureKeys,
          ...result.sourceAssessments.telegram.supportingFeatureKeys,
          ...result.sourceAssessments.chain.supportingFeatureKeys,
        ]
      : [];
    const unknownFeatureKeys = [...new Set([
      ...result.featureAssessments.map((entry) => entry.featureKey),
      ...result.discoveredRelationships.flatMap((entry) => entry.supportingFeatureKeys),
      ...result.anomalies.flatMap((entry) => entry.relatedFeatureKeys),
      ...sourceFeatureKeys,
      ...(result.entryAssessment?.supportingFeatureKeys ?? []),
    ].filter((key) => !visibleFeatureKeys.has(key)))];
    if (unknownFeatureKeys.length) {
      throw new Error(`Qwen cited feature keys not present in its prompt: ${unknownFeatureKeys.slice(0, 10).join(', ')}`);
    }
  }

  if (/<\/?think>/i.test(JSON.stringify(result))) {
    throw new Error('Qwen returned hidden-reasoning tags instead of a concise reasoning summary');
  }
  return result;
}
