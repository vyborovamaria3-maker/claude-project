import { z } from 'zod';
import { telegramContextSchema, telegramMessageSchema } from './schemas.js';

function validateCoverage(
  value: { messages: unknown[]; context?: z.infer<typeof telegramContextSchema> },
  ctx: z.RefinementCtx,
) {
  if (value.messages.length > 0) return;
  const context = value.context ?? {};
  const snapshot = context.intelligenceSnapshot;
  const hasUsableSnapshot = context.analysisMode === 'full_intelligence'
    && Boolean(snapshot?.features.some((feature) => !feature.missing));
  if (!hasUsableSnapshot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['messages'],
      message: 'At least one real message is required unless full_intelligence has a usable structured snapshot',
    });
  }
}

export const telegramAnalyzeRequestV2Schema = z.object({
  messages: z.array(telegramMessageSchema).max(500),
  context: telegramContextSchema.optional(),
  persist: z.boolean().default(false),
}).strict().superRefine(validateCoverage);

export const telegramEnqueueRequestV2Schema = z.object({
  messages: z.array(telegramMessageSchema).max(500),
  context: telegramContextSchema.optional(),
  persist: z.literal(true).default(true),
}).strict().superRefine(validateCoverage);
