import { z } from 'zod';
import { env } from '@/server/config/env.js';
import { telegramAiQueue } from '@/server/workers/queues.js';
import { createTelegramAiRun, completeTelegramAiRun, failTelegramAiRun, getTelegramAiRun } from './repository.js';
import { qwenHealth, runTelegramAi, telegramAiInputHash } from './qwenClient.js';
import { telegramAnalyzeRequestSchema, telegramEnqueueRequestSchema, type TelegramMessageInput } from './schemas.js';

function selectMessages(messages: TelegramMessageInput[]) {
  const deduped = new Map<string, TelegramMessageInput>();
  for (const message of messages) deduped.set(`${message.channelId}|${message.id}|${message.sentAt}`, message);
  const sorted = [...deduped.values()].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.id.localeCompare(b.id));
  const max = env.TELEGRAM_AI_MAX_MESSAGES;
  const selected = sorted.length <= max ? sorted : [...sorted.slice(0, Math.ceil(max / 2)), ...sorted.slice(-Math.floor(max / 2))];
  const perMessageCap = Math.max(1, Math.floor(env.TELEGRAM_AI_MAX_CHARS / selected.length));
  const bounded = selected.map((message) => ({ ...message, text: message.text.slice(0, perMessageCap) }));
  const receivedChars = messages.reduce((sum, message) => sum + message.text.length, 0);
  const analyzedChars = bounded.reduce((sum, message) => sum + message.text.length, 0);
  return {
    messages: bounded,
    droppedMessages: Math.max(0, messages.length - bounded.length),
    droppedChars: Math.max(0, receivedChars - analyzedChars),
  };
}

function assertEnabled() {
  if (!env.TELEGRAM_AI_ENABLED) throw Object.assign(new Error('Telegram AI is disabled. Set TELEGRAM_AI_ENABLED=true.'), { statusCode: 503 });
}

export async function telegramAiStatus() {
  return {
    telegramOnly: false,
    fullIntelligence: true,
    analysisModes: ['telegram_only', 'full_intelligence'],
    promptVersion: 'intelligence-qwen-v3',
    enabled: env.TELEGRAM_AI_ENABLED,
    limits: { maxMessages: env.TELEGRAM_AI_MAX_MESSAGES, maxChars: env.TELEGRAM_AI_MAX_CHARS, maxOutputTokens: env.TELEGRAM_AI_MAX_TOKENS },
    inference: await qwenHealth(),
  };
}

export async function analyzeTelegram(input: unknown) {
  assertEnabled();
  const parsed = telegramAnalyzeRequestSchema.parse(input);
  const selected = selectMessages(parsed.messages);
  if (!selected.messages.length) throw new Error('No message text remains after limits');
  const context = parsed.context ?? {};
  const inputHash = telegramAiInputHash(selected.messages, context);
  let runId: string | null = null;
  if (parsed.persist) runId = await createTelegramAiRun(selected.messages, context, inputHash, 'running');
  try {
    const completion = await runTelegramAi(selected.messages, context);
    if (runId) await completeTelegramAiRun(runId, completion);
    return { status: 'ok' as const, runId, ...completion, input: { receivedMessages: parsed.messages.length, analyzedMessages: selected.messages.length, droppedMessages: selected.droppedMessages, droppedChars: selected.droppedChars } };
  } catch (error) {
    if (runId) await failTelegramAiRun(runId, error);
    throw error;
  }
}

export async function enqueueTelegramAi(input: unknown) {
  assertEnabled();
  const parsed = telegramEnqueueRequestSchema.parse(input);
  const selected = selectMessages(parsed.messages);
  if (!selected.messages.length) throw new Error('No message text remains after limits');
  const context = parsed.context ?? {};
  const inputHash = telegramAiInputHash(selected.messages, context);
  const runId = await createTelegramAiRun(selected.messages, context, inputHash, 'queued');
  try {
    await telegramAiQueue.add('analyze-telegram-batch', { runId }, { jobId: `telegram-ai:${runId}` });
  } catch (error) {
    try { await failTelegramAiRun(runId, error); } catch { /* preserve the original queue error */ }
    throw error;
  }
  return { status: 'queued' as const, runId, input: { receivedMessages: parsed.messages.length, analyzedMessages: selected.messages.length, droppedMessages: selected.droppedMessages, droppedChars: selected.droppedChars } };
}

export async function telegramAiJob(input: unknown) {
  const { runId } = z.object({ runId: z.string().uuid() }).parse(input);
  return getTelegramAiRun(runId);
}
