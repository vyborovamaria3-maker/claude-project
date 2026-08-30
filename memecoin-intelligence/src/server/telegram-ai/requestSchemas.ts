import { z } from 'zod';
import { telegramContextSchema, telegramMessageSchema } from './schemas.js';

const analyzeRequestBase = z.object({
  messages: z.array(telegramMessageSchema).max(500),
  context: telegramContextSchema.optional(),
  persist: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (value.messages.length > 0) return;
  const context = value.context ?? {};
  const snapshot = context.intelligenceSnapshot;
  const hasUsableSnapshot = context.analysisMode === 'full_intelligence'
    && Boolean(snapshot)
    && Boolean(snapshot?.features.some((feature) => !feature.missing));
  if (!hasUsableSnapshot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['messages'],
      message: 'At least one real message is required unless full_intelligence has a usable structured snapshot',
    });
  }
});

export const telegramAnalyzeRequestV2Schema = analyzeRequestBase;
export const telegramEnqueueRequestV2Schema = analyzeRequestBase.superRefine((value, ctx) => {
  if (value.persist !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['persist'], message: 'persist must be true for enqueue' });
  }
});
