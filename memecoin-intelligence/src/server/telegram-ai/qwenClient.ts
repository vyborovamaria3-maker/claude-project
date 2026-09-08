import { createHash } from 'node:crypto';
import { env } from '@/server/config/env.js';
import { cacheGet, cacheSet } from '@/server/cache/redis.js';
import { buildTelegramPrompt, promptVisibleFeatureKeys, TELEGRAM_PROMPT_VERSION } from './prompts.js';
import { mockTelegramAnalysis } from './mock.js';
import { telegramAiResultSchema, type TelegramAiResult, type TelegramAnalysisContext, type TelegramMessageInput } from './schemas.js';
import { groundMockFullIntelligence, validateTelegramAiResult } from './validation.js';

export const FULL_INTELLIGENCE_MIN_OUTPUT_TOKENS = 3_200;
const DEFAULT_CONTEXT: TelegramAnalysisContext = { analysisMode: 'telegram_only', analysisRole: 'analyst' };

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
type CompletionOptions = { jsonMode: boolean; temperature: number; maxTokens: number };
const inFlight = new Map<string, Promise<Omit<TelegramAiCompletion, 'cache'>>>();

function isFullIntelligence(context: TelegramAnalysisContext) {
  return context.analysisMode === 'full_intelligence' && Boolean(context.intelligenceSnapshot);
}

export function completionTokenBudget(context: TelegramAnalysisContext) {
  return isFullIntelligence(context)
    ? Math.max(env.TELEGRAM_AI_MAX_TOKENS, FULL_INTELLIGENCE_MIN_OUTPUT_TOKENS)
    : env.TELEGRAM_AI_MAX_TOKENS;
}

function stableInput(messages: TelegramMessageInput[], context: TelegramAnalysisContext) {
  return JSON.stringify({
    promptVersion: TELEGRAM_PROMPT_VERSION,
    mode: env.TELEGRAM_AI_MODE,
    model: env.TELEGRAM_AI_MODEL,
    baseUrl: env.TELEGRAM_AI_MODE === 'openai-compatible' ? env.TELEGRAM_AI_BASE_URL : null,
    maxTokens: completionTokenBudget(context),
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

function parseResult(raw: string, messages: TelegramMessageInput[], context: TelegramAnalysisContext): TelegramAiResult {
  return validateTelegramAiResult(telegramAiResultSchema.parse(parseJsonObject(raw)), messages, context);
}

function fallbackSummary(raw: string) {
  const cleaned = raw
    .replace(/<\/?think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!cleaned) return 'Qwen returned an invalid JSON response, so the service produced a cautious fallback analysis.';
  return cleaned.slice(0, 900);
}

function fallbackSourceAssessment(source: 'x' | 'telegram' | 'chain', featureKeys: string[]) {
  const sourceName = source === 'x' ? 'X' : source === 'telegram' ? 'Telegram' : 'chain';
  return {
    currentSituation: `${sourceName}: данных недостаточно для надежной интерпретации в этом fallback-ответе.`,
    interpretation: `${sourceName}: исходный ответ локальной модели не прошел JSON-проверку, поэтому вывод по источнику оставлен осторожным.`,
    entryImpact: `${sourceName}: влияние на текущий тезис о входе не подтверждено достаточно надежно.`,
    supportingFeatureKeys: featureKeys,
    confidence: 0.1,
  };
}

function fallbackResult(raw: string, context: TelegramAnalysisContext): TelegramAiResult {
  const featureKeys = [...promptVisibleFeatureKeys(context)].slice(0, 6);
  const result: TelegramAiResult = {
    summary: fallbackSummary(raw),
    sentiment: { label: 'mixed', score: 0, confidence: 0.1 },
    dominantIntent: 'unknown',
    mentionedTokens: [],
    entities: [],
    claims: [],
    relationships: [],
    coordinationSignals: [],
    campaignHypothesis: {
      label: 'insufficient_data',
      confidence: 0.1,
      likelyOriginators: [],
      amplifiers: [],
      narrative: 'Локальная модель ответила, но JSON был поврежден; нужен повторный анализ или более крупная модель для уверенного вывода.',
      evidenceMessageIds: [],
    },
    risks: [],
    featureAssessments: [],
    discoveredRelationships: [],
    anomalies: [{
      type: 'invalid_llm_json',
      severity: 'low',
      confidence: 1,
      explanation: 'OpenAI-compatible локальная модель вернула синтаксически некорректный JSON; сервис вернул безопасный fallback вместо ошибки 500.',
      relatedFeatureKeys: [],
      evidenceMessageIds: [],
    }],
    contradictions: [],
    whatWouldChangeConclusion: [
      'Повторный валидный JSON-ответ локальной модели.',
      'Более крупная critic-модель или дополнительная post-processing проверка JSON.',
    ],
    reasoningSummary: [
      'Связь с локальной моделью работает, но этот ответ был понижен до fallback из-за ошибки JSON-формата.',
    ],
    overallConfidence: 0.1,
  };
  if (context.analysisMode === 'full_intelligence' && context.intelligenceSnapshot) {
    result.sourceAssessments = {
      x: fallbackSourceAssessment('x', featureKeys),
      telegram: fallbackSourceAssessment('telegram', featureKeys),
      chain: fallbackSourceAssessment('chain', featureKeys),
    };
    result.entryAssessment = {
      priceState: 'unknown',
      entryAction: 'wait_confirmation',
      oneLineVerdict: 'Вход не стоит оценивать по этому ответу: локальная модель не вернула валидный JSON, поэтому нужен повторный анализ.',
      whyNow: [],
      alreadyPricedIn: [],
      missingConfirmation: ['Валидный структурированный ответ модели.', 'Свежие подтверждения по social, market и chain источникам.'],
      invalidation: ['Повторный ответ снова ломает JSON или противоречит входным данным.'],
      supportingFeatureKeys: featureKeys,
      evidenceMessageIds: [],
      confidence: 0.1,
    };
  }
  return validateTelegramAiResult(telegramAiResultSchema.parse(result), [], context);
}

function endpointUrl() {
  return new URL('chat/completions', env.TELEGRAM_AI_BASE_URL.endsWith('/') ? env.TELEGRAM_AI_BASE_URL : `${env.TELEGRAM_AI_BASE_URL}/`);
}

async function requestCompletion(messages: OpenAiMessage[], options: CompletionOptions): Promise<RawCompletion> {
  const body: Record<string, unknown> = {
    model: env.TELEGRAM_AI_MODEL,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
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
  const maxTokens = completionTokenBudget(context);
  const baseMessages: OpenAiMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  const first = await requestCompletion(baseMessages, { jsonMode: true, temperature: env.TELEGRAM_AI_TEMPERATURE, maxTokens });
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
    ], { jsonMode: true, temperature: 0, maxTokens });
    try {
      result = parseResult(repaired.raw, messages, context);
    } catch {
      result = fallbackResult(repaired.raw || first.raw, context);
    }
    inputTokens = inputTokens === null || repaired.inputTokens === null ? null : inputTokens + repaired.inputTokens;
    outputTokens = outputTokens === null || repaired.outputTokens === null ? null : outputTokens + repaired.outputTokens;
  }
  return { result, provider: 'openai-compatible', model: env.TELEGRAM_AI_MODEL, latencyMs: performance.now() - started, inputTokens, outputTokens };
}

async function execute(messages: TelegramMessageInput[], context: TelegramAnalysisContext): Promise<Omit<TelegramAiCompletion, 'cache'>> {
  if (env.TELEGRAM_AI_MODE === 'mock') {
    const started = performance.now();
    const parsed = telegramAiResultSchema.parse(mockTelegramAnalysis(messages, context));
    const grounded = groundMockFullIntelligence(parsed, context);
    return {
      result: validateTelegramAiResult(grounded, messages, context),
      provider: 'mock',
      model: 'deterministic-telegram-mock',
      latencyMs: performance.now() - started,
      inputTokens: null,
      outputTokens: null,
    };
  }
  return callOpenAiCompatible(messages, context);
}

export async function runTelegramAi(
  messages: TelegramMessageInput[],
  context: TelegramAnalysisContext = DEFAULT_CONTEXT,
  options: { bypassCache?: boolean } = {},
): Promise<TelegramAiCompletion> {
  if (!env.TELEGRAM_AI_ENABLED) throw new Error('Telegram AI is disabled');
  const hash = telegramAiInputHash(messages, context);
  const cacheKey = `telegram-ai:${TELEGRAM_PROMPT_VERSION}:${env.TELEGRAM_AI_MODEL}:${hash}`;
  if (!options.bypassCache) {
    const cached = await cacheGet<Omit<TelegramAiCompletion, 'cache'>>(cacheKey);
    if (cached) {
      try {
        const parsed = telegramAiResultSchema.parse(cached.result);
        const result = cached.provider === 'mock' ? groundMockFullIntelligence(parsed, context) : parsed;
        return { ...cached, result: validateTelegramAiResult(result, messages, context), cache: 'hit' };
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
