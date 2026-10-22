import { randomUUID } from "node:crypto";

export type AiRole = "system" | "user" | "assistant";
export type AiMessage = Readonly<{ role: AiRole; content: string }>;

export type AiProviderDefinition = Readonly<{
  id: string;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel?: string;
  timeoutMs?: number;
  requestsPerMinute?: number;
  maxConcurrent?: number;
  maxInputChars?: number;
  maxOutputTokens?: number;
  maxEstimatedCostUsd?: number;
  inputCostPer1kUsd?: number;
  outputCostPer1kUsd?: number;
}>;

export type AiMetric = Readonly<{
  providerId: string;
  task: "chat" | "embedding";
  ok: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  statusCode?: number;
}>;

export type AiGatewayOptions = Readonly<{
  providers: readonly AiProviderDefinition[];
  defaultProviderId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onMetric?: (metric: AiMetric) => void;
  maxAttempts?: number;
}>;

export class AiGatewayError extends Error {
  readonly code: string;
  readonly statusCode: number | null;
  readonly retryable: boolean;

  constructor(code: string, statusCode: number | null = null, retryable = false) {
    super(code);
    this.name = "AiGatewayError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

type NormalizedProvider = {
  id: string;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel?: string;
  timeoutMs: number;
  requestsPerMinute: number;
  maxConcurrent: number;
  maxInputChars: number;
  maxOutputTokens: number;
  maxEstimatedCostUsd?: number;
  inputCostPer1kUsd?: number;
  outputCostPer1kUsd?: number;
};

type ProviderRuntime = {
  inFlight: number;
  requestTimestamps: number[];
  estimatedCostUsd: number;
  reservedCostUsd: number;
  successfulRequests: number;
  failedRequests: number;
};

type RequestResult = {
  payload: unknown;
  traceId: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

export type ChatCompletionRequest = Readonly<{
  providerId?: string;
  model?: string;
  messages: readonly AiMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json_object" | "text";
  signal?: AbortSignal;
}>;

export type ChatCompletionResult = Readonly<{
  content: string;
  providerId: string;
  model: string;
  traceId: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
}>;

export type EmbeddingRequest = Readonly<{
  providerId?: string;
  model?: string;
  texts: readonly string[];
  expectedDimensions?: number;
  signal?: AbortSignal;
}>;

export type EmbeddingResult = Readonly<{
  vectors: readonly (readonly number[])[];
  providerId: string;
  model: string;
  traceId: string;
  latencyMs: number;
  inputTokens: number | null;
  estimatedCostUsd: number | null;
}>;

function boundedInteger(value: unknown, fallback: number, min: number, max: number, code: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new AiGatewayError(code);
  }
  return value as number;
}

function boundedCost(value: unknown, code: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AiGatewayError(code);
  }
  return value;
}

function normalizeProvider(input: AiProviderDefinition): NormalizedProvider {
  if (!input || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.id)) {
    throw new AiGatewayError("ai_provider_id_invalid");
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length < 8) {
    throw new AiGatewayError("ai_provider_api_key_missing");
  }
  if (typeof input.chatModel !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(input.chatModel)) {
    throw new AiGatewayError("ai_chat_model_invalid");
  }
  if (input.embeddingModel !== undefined &&
      (typeof input.embeddingModel !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(input.embeddingModel))) {
    throw new AiGatewayError("ai_embedding_model_invalid");
  }
  let parsed: URL;
  try { parsed = new URL(input.baseUrl); } catch { throw new AiGatewayError("ai_provider_url_invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AiGatewayError("ai_provider_url_must_be_https");
  }
  const baseUrl = parsed.toString().replace(/\/+$/, "");
  const inputCostPer1kUsd = boundedCost(input.inputCostPer1kUsd, "ai_input_cost_invalid");
  const outputCostPer1kUsd = boundedCost(input.outputCostPer1kUsd, "ai_output_cost_invalid");
  const maxEstimatedCostUsd = boundedCost(input.maxEstimatedCostUsd, "ai_cost_budget_invalid");
  if ((inputCostPer1kUsd === undefined) !== (outputCostPer1kUsd === undefined)) {
    throw new AiGatewayError("ai_cost_rates_must_be_paired");
  }
  if (maxEstimatedCostUsd !== undefined &&
      (inputCostPer1kUsd === undefined || outputCostPer1kUsd === undefined)) {
    throw new AiGatewayError("ai_cost_budget_requires_cost_rates");
  }
  return {
    id: input.id,
    baseUrl,
    apiKey: input.apiKey,
    chatModel: input.chatModel,
    ...(input.embeddingModel ? { embeddingModel: input.embeddingModel } : {}),
    timeoutMs: boundedInteger(input.timeoutMs, 20_000, 1_000, 120_000, "ai_timeout_invalid"),
    requestsPerMinute: boundedInteger(input.requestsPerMinute, 60, 1, 10_000, "ai_rate_limit_invalid"),
    maxConcurrent: boundedInteger(input.maxConcurrent, 2, 1, 64, "ai_concurrency_invalid"),
    maxInputChars: boundedInteger(input.maxInputChars, 24_000, 1_000, 1_000_000, "ai_input_limit_invalid"),
    maxOutputTokens: boundedInteger(input.maxOutputTokens, 2_000, 64, 32_000, "ai_output_limit_invalid"),
    ...(maxEstimatedCostUsd !== undefined ? { maxEstimatedCostUsd } : {}),
    ...(inputCostPer1kUsd !== undefined ? { inputCostPer1kUsd } : {}),
    ...(outputCostPer1kUsd !== undefined ? { outputCostPer1kUsd } : {}),
  };
}

function responseContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new AiGatewayError("ai_provider_response_invalid");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) throw new AiGatewayError("ai_provider_response_invalid");
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => part && typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("");
    if (text) return text;
  }
  throw new AiGatewayError("ai_provider_response_invalid");
}

function tokenUsage(payload: unknown): { inputTokens: number | null; outputTokens: number | null } {
  if (!payload || typeof payload !== "object") return { inputTokens: null, outputTokens: null };
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return { inputTokens: null, outputTokens: null };
  const row = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
  const input = row.prompt_tokens ?? row.input_tokens;
  const output = row.completion_tokens ?? row.output_tokens;
  return {
    inputTokens: Number.isSafeInteger(input) && (input as number) >= 0 ? input as number : null,
    outputTokens: Number.isSafeInteger(output) && (output as number) >= 0 ? output as number : null,
  };
}

function estimateCost(provider: NormalizedProvider, inputTokens: number | null, outputTokens: number | null,
  task: "chat" | "embedding"): number | null {
  if (provider.inputCostPer1kUsd === undefined || inputTokens === null) return null;
  if (task === "embedding") return inputTokens * provider.inputCostPer1kUsd / 1_000;
  if (provider.outputCostPer1kUsd === undefined || outputTokens === null) return null;
  return inputTokens * provider.inputCostPer1kUsd / 1_000 +
    outputTokens * provider.outputCostPer1kUsd / 1_000;
}

function estimatedReservation(provider: NormalizedProvider, inputChars: number, outputTokens: number): number | null {
  if (provider.inputCostPer1kUsd === undefined || provider.outputCostPer1kUsd === undefined) return null;
  return Math.ceil(inputChars / 4) * provider.inputCostPer1kUsd / 1_000 +
    outputTokens * provider.outputCostPer1kUsd / 1_000;
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return 0;
  return Math.min(5_000, Math.max(0, Number(raw) * 1_000));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerJson(raw: unknown): Array<{
  id: string; baseUrl: string; apiKeyEnv: string; chatModel: string;
  embeddingModel?: string; timeoutMs?: number; requestsPerMinute?: number;
  maxConcurrent?: number; maxInputChars?: number; maxOutputTokens?: number;
  maxEstimatedCostUsd?: number; inputCostPer1kUsd?: number; outputCostPer1kUsd?: number;
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw ?? "")); } catch { throw new AiGatewayError("ai_provider_config_json_invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) {
    throw new AiGatewayError("ai_provider_config_list_invalid");
  }
  return parsed.map((item) => {
    if (!isPlainObject(item) || Object.hasOwn(item, "apiKey")) {
      throw new AiGatewayError("ai_provider_config_must_reference_secret_env");
    }
    const { id, baseUrl, apiKeyEnv, chatModel } = item;
    if (typeof id !== "string" || typeof baseUrl !== "string" ||
        typeof chatModel !== "string" || typeof apiKeyEnv !== "string" ||
        !/^[A-Z][A-Z0-9_]{1,63}$/.test(apiKeyEnv)) {
      throw new AiGatewayError("ai_provider_config_invalid");
    }
    const optionalString = (key: string): string | undefined => {
      const value = item[key];
      if (value === undefined) return undefined;
      if (typeof value !== "string") throw new AiGatewayError("ai_provider_config_invalid");
      return value;
    };
    const optionalNumber = (key: string): number | undefined => {
      const value = item[key];
      if (value === undefined) return undefined;
      if (typeof value !== "number") throw new AiGatewayError("ai_provider_config_invalid");
      return value;
    };
    return {
      id, baseUrl, apiKeyEnv, chatModel,
      ...(optionalString("embeddingModel") ? { embeddingModel: optionalString("embeddingModel") } : {}),
      ...(optionalNumber("timeoutMs") !== undefined ? { timeoutMs: optionalNumber("timeoutMs") } : {}),
      ...(optionalNumber("requestsPerMinute") !== undefined ? { requestsPerMinute: optionalNumber("requestsPerMinute") } : {}),
      ...(optionalNumber("maxConcurrent") !== undefined ? { maxConcurrent: optionalNumber("maxConcurrent") } : {}),
      ...(optionalNumber("maxInputChars") !== undefined ? { maxInputChars: optionalNumber("maxInputChars") } : {}),
      ...(optionalNumber("maxOutputTokens") !== undefined ? { maxOutputTokens: optionalNumber("maxOutputTokens") } : {}),
      ...(optionalNumber("maxEstimatedCostUsd") !== undefined ? { maxEstimatedCostUsd: optionalNumber("maxEstimatedCostUsd") } : {}),
      ...(optionalNumber("inputCostPer1kUsd") !== undefined ? { inputCostPer1kUsd: optionalNumber("inputCostPer1kUsd") } : {}),
      ...(optionalNumber("outputCostPer1kUsd") !== undefined ? { outputCostPer1kUsd: optionalNumber("outputCostPer1kUsd") } : {}),
    };
  });
}

export function createAiGateway(options: AiGatewayOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = boundedInteger(options.maxAttempts, 2, 1, 4, "ai_retry_limit_invalid");
  const providers = new Map<string, NormalizedProvider>();
  const runtime = new Map<string, ProviderRuntime>();
  for (const raw of options.providers) {
    const provider = normalizeProvider(raw);
    if (providers.has(provider.id)) throw new AiGatewayError("ai_provider_id_duplicate");
    providers.set(provider.id, provider);
    runtime.set(provider.id, {
      inFlight: 0, requestTimestamps: [], estimatedCostUsd: 0, reservedCostUsd: 0, successfulRequests: 0, failedRequests: 0,
    });
  }
  if (!providers.has(options.defaultProviderId)) throw new AiGatewayError("ai_default_provider_missing");

  function emitMetric(metric: AiMetric): void {
    try { options.onMetric?.(metric); } catch { /* telemetry must not change request results */ }
  }

  function getProvider(providerId?: string): NormalizedProvider {
    const id = providerId ?? options.defaultProviderId;
    const provider = providers.get(id);
    if (!provider) throw new AiGatewayError("ai_provider_not_configured");
    return provider;
  }

  async function postJson(
    provider: NormalizedProvider,
    path: "chat/completions" | "embeddings",
    body: Record<string, unknown>,
    inputChars: number,
    task: "chat" | "embedding",
    outputTokenBudget: number,
    signal?: AbortSignal,
  ): Promise<RequestResult> {
    const state = runtime.get(provider.id)!;
    if (state.inFlight >= provider.maxConcurrent) throw new AiGatewayError("ai_provider_capacity_exhausted", null, true);
    const reservation = estimatedReservation(provider, inputChars, outputTokenBudget);
    if (provider.maxEstimatedCostUsd !== undefined &&
        (reservation === null || state.estimatedCostUsd + state.reservedCostUsd + reservation > provider.maxEstimatedCostUsd)) {
      throw new AiGatewayError("ai_provider_cost_budget_exhausted");
    }
    const budgetReservation = provider.maxEstimatedCostUsd === undefined ? 0 : (reservation ?? 0);
    const started = now();
    state.inFlight++;
    state.reservedCostUsd += budgetReservation;
    let reservationReleased = false;
    let lastStatus: number | null = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) throw new AiGatewayError("ai_request_aborted");
        const current = now();
        state.requestTimestamps = state.requestTimestamps.filter((time) => current - time < 60_000);
        if (state.requestTimestamps.length >= provider.requestsPerMinute) {
          throw new AiGatewayError("ai_provider_rate_limit_exhausted", 429, true);
        }
        state.requestTimestamps.push(current);
        let response: Response;
        try {
          const timeoutSignal = AbortSignal.timeout(provider.timeoutMs);
          const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
          response = await fetchImpl(new URL(path, provider.baseUrl + "/"), {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + provider.apiKey },
            body: JSON.stringify(body),
            signal: requestSignal,
          });
        } catch {
          if (signal?.aborted) throw new AiGatewayError("ai_request_aborted");
          if (attempt >= maxAttempts) throw new AiGatewayError("ai_provider_network_error", null, true);
          await sleep(Math.min(1_000, 100 * (2 ** (attempt - 1))));
          continue;
        }
        if (!response.ok) {
          lastStatus = response.status;
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < maxAttempts) {
            await sleep(Math.max(100, retryAfterMs(response) || 100 * (2 ** (attempt - 1))));
            continue;
          }
          const code = response.status === 401 || response.status === 403
            ? "ai_provider_auth_failed"
            : response.status === 429 ? "ai_provider_rate_limited" : "ai_provider_http_error";
          throw new AiGatewayError(code, response.status, retryable);
        }
        let payload: unknown;
        try { payload = await response.json(); } catch { throw new AiGatewayError("ai_provider_response_invalid"); }
        const usage = tokenUsage(payload);
        const actualCost = estimateCost(provider, usage.inputTokens, usage.outputTokens, task);
        state.estimatedCostUsd += actualCost ?? reservation ?? 0;
        state.reservedCostUsd = Math.max(0, state.reservedCostUsd - budgetReservation);
        reservationReleased = true;
        const latencyMs = Math.max(0, now() - started);
        return { payload, traceId: randomUUID(), latencyMs, ...usage, estimatedCostUsd: actualCost };
      }
      throw new AiGatewayError("ai_provider_http_error", lastStatus, true);
    } catch (error) {
      state.failedRequests++;
      const statusCode = error instanceof AiGatewayError ? error.statusCode ?? undefined : undefined;
      emitMetric({
        providerId: provider.id, task, ok: false, latencyMs: Math.max(0, now() - started),
        inputTokens: null, outputTokens: null, estimatedCostUsd: null,
        ...(statusCode !== undefined ? { statusCode } : {}),
      });
      throw error instanceof AiGatewayError ? error : new AiGatewayError("ai_provider_request_failed");
    } finally {
      if (!reservationReleased) state.reservedCostUsd = Math.max(0, state.reservedCostUsd - budgetReservation);
      state.inFlight--;
    }
  }

  return {
    async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 100) {
        throw new AiGatewayError("ai_messages_invalid");
      }
      let inputChars = 0;
      for (const message of request.messages) {
        if (!message || !["system", "user", "assistant"].includes(message.role) ||
            typeof message.content !== "string" || message.content.length < 1) {
          throw new AiGatewayError("ai_message_invalid");
        }
        inputChars += message.content.length;
      }
      const provider = getProvider(request.providerId);
      if (inputChars > provider.maxInputChars) throw new AiGatewayError("ai_input_too_large");
      const model = request.model ?? provider.chatModel;
      if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) throw new AiGatewayError("ai_chat_model_invalid");
      const temperature = request.temperature ?? 0.1;
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        throw new AiGatewayError("ai_temperature_invalid");
      }
      const maxTokens = boundedInteger(request.maxTokens, Math.min(1_000, provider.maxOutputTokens),
        1, provider.maxOutputTokens, "ai_output_tokens_invalid");
      const body: Record<string, unknown> = {
        model, messages: request.messages, temperature, max_tokens: maxTokens, stream: false,
      };
      if (request.responseFormat === "json_object") body.response_format = { type: "json_object" };
      const result = await postJson(provider, "chat/completions", body, inputChars, "chat", maxTokens, request.signal);
      let content: string;
      try { content = responseContent(result.payload); }
      catch (error) {
        const state = runtime.get(provider.id)!; state.failedRequests++;
        emitMetric({providerId:provider.id,task:"chat",ok:false,latencyMs:result.latencyMs,inputTokens:result.inputTokens,
          outputTokens:result.outputTokens,estimatedCostUsd:result.estimatedCostUsd});
        throw error;
      }
      const state = runtime.get(provider.id)!; state.successfulRequests++;
      emitMetric({providerId:provider.id,task:"chat",ok:true,latencyMs:result.latencyMs,inputTokens:result.inputTokens,
        outputTokens:result.outputTokens,estimatedCostUsd:result.estimatedCostUsd});
      return {content,providerId:provider.id,model,traceId:result.traceId,latencyMs:result.latencyMs,
        inputTokens:result.inputTokens,outputTokens:result.outputTokens,estimatedCostUsd:result.estimatedCostUsd};
    },
    async createEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResult> {
      if (!Array.isArray(request.texts) || request.texts.length < 1 || request.texts.length > 128 ||
          Array.from({length:request.texts.length},(_,index)=>request.texts[index])
            .some((text) => typeof text !== "string" || text.length < 1)) {
        throw new AiGatewayError("ai_embedding_input_invalid");
      }
      const provider = getProvider(request.providerId);
      if (!provider.embeddingModel && !request.model) throw new AiGatewayError("ai_embedding_model_not_configured");
      const model = request.model ?? provider.embeddingModel!;
      if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) throw new AiGatewayError("ai_embedding_model_invalid");
      const inputChars = request.texts.reduce((sum, text) => sum + text.length, 0);
      if (inputChars > provider.maxInputChars) throw new AiGatewayError("ai_input_too_large");
      const result = await postJson(provider, "embeddings", {
        model, input: request.texts,
      }, inputChars, "embedding", 0, request.signal);
      try {
        if (!result.payload || typeof result.payload !== "object" || !Array.isArray((result.payload as { data?: unknown }).data))
          throw new AiGatewayError("ai_embedding_response_invalid");
        const data = (result.payload as { data: Array<{ index?: unknown; embedding?: unknown }> }).data;
        if (data.length !== request.texts.length) throw new AiGatewayError("ai_embedding_response_invalid");
        const vectors: number[][] = new Array(request.texts.length), seenIndices = new Set<number>();
        for (const item of data) {
          if (!item || typeof item !== "object" || !Number.isSafeInteger(item.index) || (item.index as number) < 0 ||
              (item.index as number) >= request.texts.length || seenIndices.has(item.index as number) ||
              !Array.isArray(item.embedding) || item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value)))
            throw new AiGatewayError("ai_embedding_response_invalid");
          seenIndices.add(item.index as number); vectors[item.index as number] = item.embedding as number[];
        }
        for (let index=0; index<vectors.length; index++) if (!Array.isArray(vectors[index]))
          throw new AiGatewayError("ai_embedding_response_invalid");
        if (request.expectedDimensions !== undefined &&
            (!Number.isSafeInteger(request.expectedDimensions) || request.expectedDimensions < 1 ||
             vectors.some((vector) => vector.length !== request.expectedDimensions)))
          throw new AiGatewayError("ai_embedding_dimensions_mismatch");
        const state = runtime.get(provider.id)!; state.successfulRequests++;
        emitMetric({providerId:provider.id,task:"embedding",ok:true,latencyMs:result.latencyMs,inputTokens:result.inputTokens,
          outputTokens:null,estimatedCostUsd:result.estimatedCostUsd});
        return {vectors,providerId:provider.id,model,traceId:result.traceId,latencyMs:result.latencyMs,
          inputTokens:result.inputTokens,estimatedCostUsd:result.estimatedCostUsd};
      } catch (error) {
        const state = runtime.get(provider.id)!; state.failedRequests++;
        const statusCode = error instanceof AiGatewayError ? error.statusCode ?? undefined : undefined;
        emitMetric({providerId:provider.id,task:"embedding",ok:false,latencyMs:result.latencyMs,inputTokens:result.inputTokens,
          outputTokens:null,estimatedCostUsd:result.estimatedCostUsd,...(statusCode!==undefined?{statusCode}:{})});
        throw error;
      }
    },
    getMetrics() {
      return [...runtime.entries()].map(([providerId, state]) => ({
        providerId, inFlight: state.inFlight,
        recentRequests: state.requestTimestamps.length,
        estimatedCostUsd: state.estimatedCostUsd,
        reservedCostUsd: state.reservedCostUsd,
        successfulRequests: state.successfulRequests,
        failedRequests: state.failedRequests,
      }));
    },
  };
}

export type AiGateway = ReturnType<typeof createAiGateway>;

export function createAiGatewayFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<AiGatewayOptions, "providers" | "defaultProviderId"> = {},
): AiGateway {
  if (env.AI_GATEWAY_ENABLED !== "true") throw new AiGatewayError("ai_gateway_disabled");
  const defaultProviderId = env.AI_DEFAULT_PROVIDER;
  if (!defaultProviderId) throw new AiGatewayError("ai_default_provider_missing");
  const configured = providerJson(env.AI_PROVIDERS_JSON);
  const providers: AiProviderDefinition[] = configured.map((item) => {
    const apiKey = env[item.apiKeyEnv];
    if (!apiKey) throw new AiGatewayError("ai_provider_api_key_missing");
    return {
      id: item.id, baseUrl: item.baseUrl, apiKey, chatModel: item.chatModel,
      ...(item.embeddingModel ? { embeddingModel: item.embeddingModel } : {}),
      ...(item.timeoutMs !== undefined ? { timeoutMs: item.timeoutMs } : {}),
      ...(item.requestsPerMinute !== undefined ? { requestsPerMinute: item.requestsPerMinute } : {}),
      ...(item.maxConcurrent !== undefined ? { maxConcurrent: item.maxConcurrent } : {}),
      ...(item.maxInputChars !== undefined ? { maxInputChars: item.maxInputChars } : {}),
      ...(item.maxOutputTokens !== undefined ? { maxOutputTokens: item.maxOutputTokens } : {}),
      ...(item.maxEstimatedCostUsd !== undefined ? { maxEstimatedCostUsd: item.maxEstimatedCostUsd } : {}),
      ...(item.inputCostPer1kUsd !== undefined ? { inputCostPer1kUsd: item.inputCostPer1kUsd } : {}),
      ...(item.outputCostPer1kUsd !== undefined ? { outputCostPer1kUsd: item.outputCostPer1kUsd } : {}),
    };
  });
  return createAiGateway({ ...options, providers, defaultProviderId });
}
