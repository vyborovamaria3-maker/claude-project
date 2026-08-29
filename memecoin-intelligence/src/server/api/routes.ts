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
function identity(request: any) {
  return request.securityIdentity as { ownerId: string; role: 'admin' | 'user' } | undefined;
}

function analysisAccess(request: any) {
  const requester = identity(request);
  return {
    ownerId: requester?.ownerId ?? '',
    isAdmin: !env.SECURITY_RBAC_ENABLED || requester?.role === 'admin',
  };
}

export async function registerRoutes(app: FastifyInstance) {
  await installAccessControl(app, {
    rbacEnabled: env.SECURITY_RBAC_ENABLED,
    legacyApiKey: env.INTERNAL_API_KEY,
    adminApiKey: env.INTERNAL_ADMIN_API_KEY,
    userApiKey: env.INTERNAL_USER_API_KEY,
  });

  app.get('/api/health', async () => health());
  app.get('/api/xanalysis/searchStatus', async () => searchStatus());
  app.get('/api/telegram-ai/status', async (request, reply) => {
    if (!requireRole(request, reply, ['admin', 'user'], true)) return;
    const identity = (request as typeof request & { securityIdentity?: { role?: string } }).securityIdentity;
    return telegramAiStatus({ detailed: identity?.role === 'admin' });
  });
  app.post('/api/telegram-ai/analyze', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requireRole(request, reply, ['admin', 'user'], true)) return;
    return analyzeTelegram(body(request), identity(request)!.ownerId);
  });
  app.post('/api/telegram-ai/enqueue', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requireRole(request, reply, ['admin', 'user'], true)) return;
    return enqueueTelegramAi(body(request), identity(request)!.ownerId);
  });
  app.post('/api/telegram-ai/job', async (request, reply) => {
    if (!requireRole(request, reply, ['admin', 'user'], true)) return;
    return telegramAiJob(body(request), { ownerId: identity(request)!.ownerId, isAdmin: identity(request)!.role === 'admin' });
  });
  app.post('/api/xanalysis/searchMentions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => searchMentions(body(request)));
  app.post('/api/analysis/enqueue', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requireRole(request, reply, ['admin', 'user'], env.SECURITY_RBAC_ENABLED)) return;
    return enqueueAnalysis(body(request), identity(request)?.ownerId ?? null);
  });
  app.post('/api/analysis/job', async (request, reply) => {
    if (!requireRole(request, reply, ['admin', 'user'], env.SECURITY_RBAC_ENABLED)) return;
    return analysisJob(body(request), analysisAccess(request));
  });
  app.post('/api/xanalysis/listTokens', async () => listTokens());
  app.post('/api/xanalysis/lookupToken', async (request) => lookupToken(body(request)));
  app.post('/api/xanalysis/getToken', async (request) => tokenDetail(body(request)));
  app.post('/api/xanalysis/addToken', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], true)) return;
    return addToken(body(request));
  });
  app.post('/api/xanalysis/refreshMetadata', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], true)) return;
    return refreshMetadata(body(request));
  });
  app.post('/api/xanalysis/recordMentions', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], true)) return;
    const { tokenId, mentions } = z.object({ tokenId: z.string().uuid(), mentions: z.number().int().min(0) }).parse(body(request));
    return recordSnapshot(tokenId, mentions);
  });
  app.post('/api/xanalysis/removeToken', async (request, reply) => {
    if (!requireRole(request, reply, ['admin'], true)) return;
    const { address } = z.object({ address: z.string() }).parse(body(request));
    return removeToken(address);
  });
}
