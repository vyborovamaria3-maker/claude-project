import { createHash } from 'node:crypto';
import { env } from '@/server/config/env.js';
import { cacheGet, cacheSet } from '@/server/cache/redis.js';
import { buildTelegramPrompt, promptVisibleFeatureKeys, TELEGRAM_PROMPT_VERSION } from './prompts.js';
import { mockTelegramAnalysis } from './mock.js';
import { telegramAiResultSchema, telegramContextSchema, type TelegramAiResult, type TelegramAnalysisContext, type TelegramMessageInput } from './schemas.js';

export type TelegramAiCompletion = {
  result: TelegramAiResult;
  provider: 'mock' | 'openai-compatible';
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cache: 'hit' | 'miss' | 'shared';
};

type OpenAiMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type OpenAiChoice = { message?: { content?: string | Array<{ type?: string; text?: string }> } };
type OpenAiResponse = {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
  detail?: string;
};

type RawCompletion = { raw: string; inputTokens: number | null; outputTokens: number | null };
const inFlight = new Map<string, Promise<Omit<TelegramAiCompletion, 'cache'>>>();

function stableInput(messages: TelegramMessageInput[], context: TelegramAnalysisContext) {
  return JSON.stringify({
    promptVersion: TELEGRAM_PROMPT_VERSION,
    mode: env.TELEGRAM_AI_MODE,
    model: env.TELEGRAM_AI_MODEL,
    baseUrl: env.TELEGRAM_AI_MODE === 'openai-compatible' ? env.TELEGRAM_AI_BASE_URL : null,
    maxTokens: env.TELEGRAM_AI_MAX_TOKENS,
    temperature: env.TELEGRAM_AI_TEMPERATURE,
    context,
    messages: [...messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.id.localeCompare(b.id)),
  });
}

export function telegramAiInputHash(messages: TelegramMessageInput[], context: TelegramAnalysisContext) {
  return createHash('sha256').update(stableInput(messages, context)).digest('hex');
}

function contentText(choice: OpenAiChoice | undefined): string {
  const raw = choice?.message?.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((part) => part.text ?? '').join('');
  return '';
}

function parseJsonObject(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* extract the outermost object */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Qwen returned no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateResult(result: TelegramAiResult, messages: TelegramMessageInput[], context: TelegramAnalysisContext): TelegramAiResult {
  context = telegramContextSchema.parse(context);
  result = telegramAiResultSchema.parse(result);
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
  ];
  const unknownEvidence = [...new Set(evidenceGroups.flat().filter((id) => !allowedEvidence.has(id)))];
  if (unknownEvidence.length) throw new Error(`Qwen cited unknown evidence IDs: ${unknownEvidence.slice(0, 10).join(', ')}`);

  const visibleFeatureKeys = promptVisibleFeatureKeys(context);
  if (visibleFeatureKeys.size) {
    const unknownFeatureKeys = [...new Set([
      ...result.featureAssessments.map((entry) => entry.featureKey),
      ...result.discoveredRelationships.flatMap((entry) => entry.supportingFeatureKeys),
      ...result.anomalies.flatMap((entry) => entry.relatedFeatureKeys),
    ].filter((key) => !visibleFeatureKeys.has(key)))];
    if (unknownFeatureKeys.length) throw new Error(`Qwen cited feature keys not present in its prompt: ${unknownFeatureKeys.slice(0, 10).join(', ')}`);
  }

  if (/<\/?think>/i.test(JSON.stringify(result))) throw new Error('Qwen returned hidden-reasoning tags instead of a concise reasoning summary');
  return result;
}

function parseResult(raw: string, messages: TelegramMessageInput[], context: TelegramAnalysisContext): TelegramAiResult {
  return validateResult(telegramAiResultSchema.parse(parseJsonObject(raw)), messages, context);
}

function endpointUrl() {
  return new URL('chat/completions', env.TELEGRAM_AI_BASE_URL.endsWith('/') ? env.TELEGRAM_AI_BASE_URL : `${env.TELEGRAM_AI_BASE_URL}/`);
}

async function requestCompletion(messages: OpenAiMessage[], options: { jsonMode: boolean; temperature: number }): Promise<RawCompletion> {
  const body: Record<string, unknown> = {
    model: env.TELEGRAM_AI_MODEL,
    messages,
    temperature: options.temperature,
    max_tokens: env.TELEGRAM_AI_MAX_TOKENS,
    stream: false,
  };
  if (options.jsonMode) body.response_format = { type: 'json_object' };

  const response = await fetch(endpointUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.TELEGRAM_AI_API_KEY ? { authorization: `Bearer ${env.TELEGRAM_AI_API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(env.TELEGRAM_AI_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({})) as OpenAiResponse;
  if (!response.ok) {
    const message = payload.error?.message || payload.detail || `Qwen inference failed (HTTP ${response.status})`;
    if (options.jsonMode && response.status === 400 && /response[_ ]?format|json mode|unsupported/i.test(message)) {
      return requestCompletion(messages, { ...options, jsonMode: false });
    }
    throw new Error(message);
  }
  const raw = contentText(payload.choices?.[0]);
  if (!raw.trim()) throw new Error('Qwen returned an empty completion');
  return { raw, inputTokens: payload.usage?.prompt_tokens ?? null, outputTokens: payload.usage?.completion_tokens ?? null };
}

async function callOpenAiCompatible(messages: TelegramMessageInput[], context: TelegramAnalysisContext): Promise<Omit<TelegramAiCompletion, 'cache'>> {
  const prompt = buildTelegramPrompt(messages, context);
  const started = performance.now();
  const baseMessages: OpenAiMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  const first = await requestCompletion(baseMessages, { jsonMode: true, temperature: env.TELEGRAM_AI_TEMPERATURE });
  let result: TelegramAiResult;
  let inputTokens = first.inputTokens;
  let outputTokens = first.outputTokens;
  try {
    result = parseResult(first.raw, messages, context);
  } catch (error) {
    const validation = error instanceof Error ? error.message.slice(0, 2_000) : 'Invalid JSON schema';
    const repaired = await requestCompletion([
      ...baseMessages,
      { role: 'assistant', content: first.raw.slice(0, 12_000) },
      { role: 'user', content: `The previous answer failed JSON schema validation: ${validation}. Return a corrected JSON object only. Do not add markdown or explanations.` },
    ], { jsonMode: true, temperature: 0 });
    result = parseResult(repaired.raw, messages, context);
    inputTokens = inputTokens === null || repaired.inputTokens === null ? null : inputTokens + repaired.inputTokens;
    outputTokens = outputTokens === null || repaired.outputTokens === null ? null : outputTokens + repaired.outputTokens;
  }
  return { result, provider: 'openai-compatible', model: env.TELEGRAM_AI_MODEL, latencyMs: performance.now() - started, inputTokens, outputTokens };
}

async function execute(messages: TelegramMessageInput[], context: TelegramAnalysisContext): Promise<Omit<TelegramAiCompletion, 'cache'>> {
  if (env.TELEGRAM_AI_MODE === 'mock') {
    const started = performance.now();
    return {
      result: validateResult(telegramAiResultSchema.parse(mockTelegramAnalysis(messages, context)), messages, context),
      provider: 'mock',
      model: 'deterministic-telegram-mock',
      latencyMs: performance.now() - started,
      inputTokens: null,
      outputTokens: null,
    };
  }
  return callOpenAiCompatible(messages, context);
}

export async function runTelegramAi(messages: TelegramMessageInput[], context: TelegramAnalysisContext = {}, options: { bypassCache?: boolean } = {}): Promise<TelegramAiCompletion> {
  if (!env.TELEGRAM_AI_ENABLED) throw new Error('Telegram AI is disabled');
  const hash = telegramAiInputHash(messages, context);
  const cacheKey = `telegram-ai:${TELEGRAM_PROMPT_VERSION}:${env.TELEGRAM_AI_MODEL}:${hash}`;
  if (!options.bypassCache) {
    const cached = await cacheGet<Omit<TelegramAiCompletion, 'cache'>>(cacheKey);
    if (cached) {
      try {
        const result = validateResult(telegramAiResultSchema.parse(cached.result), messages, context);
        return { ...cached, result, cache: 'hit' };
      } catch {
        // Treat stale/corrupt cache entries as misses instead of returning invalid AI data.
      }
    }
  }
  const existing = inFlight.get(cacheKey);
  if (existing) return { ...(await existing), cache: 'shared' };
  const promise = execute(messages, context);
  inFlight.set(cacheKey, promise);
  try {
    const completion = await promise;
    await cacheSet(cacheKey, completion, env.TELEGRAM_AI_CACHE_SECONDS);
    return { ...completion, cache: 'miss' };
  } finally {
    inFlight.delete(cacheKey);
  }
}

export async function qwenHealth(): Promise<{ configured: boolean; reachable: boolean | null; mode: string; model: string; baseUrl: string | null; error?: string }> {
  if (!env.TELEGRAM_AI_ENABLED) return { configured: false, reachable: null, mode: env.TELEGRAM_AI_MODE, model: env.TELEGRAM_AI_MODEL, baseUrl: null };
  if (env.TELEGRAM_AI_MODE === 'mock') return { configured: true, reachable: true, mode: 'mock', model: 'deterministic-telegram-mock', baseUrl: null };
  try {
    const endpoint = new URL('health', env.TELEGRAM_AI_BASE_URL.replace(/\/v1\/?$/, '/'));
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(Math.min(5_000, env.TELEGRAM_AI_TIMEOUT_MS)) });
    return { configured: true, reachable: response.ok, mode: env.TELEGRAM_AI_MODE, model: env.TELEGRAM_AI_MODEL, baseUrl: env.TELEGRAM_AI_BASE_URL, ...(!response.ok ? { error: `HTTP ${response.status}` } : {}) };
  } catch (error) {
    return { configured: true, reachable: false, mode: env.TELEGRAM_AI_MODE, model: env.TELEGRAM_AI_MODEL, baseUrl: env.TELEGRAM_AI_BASE_URL, error: error instanceof Error ? error.message : 'Health check failed' };
  }
}
