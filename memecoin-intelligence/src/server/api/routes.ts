import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addToken, health, listTokens, lookupToken, recordSnapshot, refreshMetadata, removeToken,
  searchMentions, searchStatus, tokenDetail,
} from '@/server/services/analysisService.js';
import { analysisJob, enqueueAnalysis } from '@/server/services/jobService.js';
import { analyzeTelegram, enqueueTelegramAi, telegramAiJob, telegramAiStatus } from '@/server/telegram-ai/service.js';
import { env } from '@/server/config/env.js';
import { installAccessControl } from '@/server/security/accessControl.js';
import { requireRole } from '@/server/security/rbac.js';

const body = (request: any) => request.body ?? {};
export async function registerRoutes(app: FastifyInstance) {
  await installAccessControl(app, {
    rbacEnabled: env.SECURITY_RBAC_ENABLED,
    legacyApiKey: env.INTERNAL_API_KEY,
    adminApiKey: env.INTERNAL_ADMIN_API_KEY,
    userApiKey: env.INTERNAL_USER_API_KEY,
  });

  app.get('/api/health', async () => health());
  app.get('/api/xanalysis/searchStatus', async () => searchStatus());
  app.get('/api/telegram-ai/status', async () => telegramAiStatus());
  app.post('/api/telegram-ai/analyze', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => analyzeTelegram(body(request)));
  app.post('/api/telegram-ai/enqueue', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => enqueueTelegramAi(body(request)));
  app.post('/api/telegram-ai/job', async (request) => telegramAiJob(body(request)));
  app.post('/api/xanalysis/searchMentions', async (request) => searchMentions(body(request)));
  app.post('/api/analysis/enqueue', async (request) => enqueueAnalysis(body(request)));
  app.post('/api/analysis/job', async (request) => analysisJob(body(request)));
  app.post('/api/xanalysis/listTokens', async () => listTokens());
  app.post('/api/xanalysis/lookupToken', async (request) => lookupToken(body(request)));
  app.post('/api/xanalysis/getToken', async (request) => tokenDetail(body(request)));
  app.post('/api/xanalysis/addToken', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], env.SECURITY_RBAC_ENABLED)) return;
    return addToken(body(request));
  });
  app.post('/api/xanalysis/refreshMetadata', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], env.SECURITY_RBAC_ENABLED)) return;
    return refreshMetadata(body(request));
  });
  app.post('/api/xanalysis/recordMentions', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], env.SECURITY_RBAC_ENABLED)) return;
    const { tokenId, mentions } = z.object({ tokenId: z.string().uuid(), mentions: z.number().int().min(0) }).parse(body(request));
    return recordSnapshot(tokenId, mentions);
  });
  app.post('/api/xanalysis/removeToken', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], env.SECURITY_RBAC_ENABLED)) return;
    const { address } = z.object({ address: z.string() }).parse(body(request));
    return removeToken(address);
  });
}
