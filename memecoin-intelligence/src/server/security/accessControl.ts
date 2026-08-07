import type { FastifyInstance } from 'fastify';
import { auditEvent } from './audit.js';
import { resolveIdentity, requiresAuthentication, type AccessPolicyConfig } from './accessPolicy.js';

export async function installAccessControl(app: FastifyInstance, config: AccessPolicyConfig): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/health') return;

    const rawKey = request.headers['x-api-key'];
    const providedApiKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const identity = resolveIdentity(providedApiKey, config);

    if (!requiresAuthentication(config)) return;
    if (!identity) {
      auditEvent('api-auth-rejected', { method: request.method, url: request.url });
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Context is additive only; existing handlers do not depend on it.
    (request as typeof request & { securityIdentity?: typeof identity }).securityIdentity = identity;
  });
}
