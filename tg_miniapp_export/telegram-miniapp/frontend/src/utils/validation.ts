import { z } from 'zod';

export const paymentSchema = z.object({
  network: z.string().min(2),
});

export const accessSchema = z.object({
  password: z.string().min(6, 'Минимум 6 символов'),
});

export const watchlistSchema = z.object({
  symbol: z.string().min(1),
  note: z.string().optional(),
});
