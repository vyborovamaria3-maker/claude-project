import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasRole, type Role } from './auth.js';
import type { SecurityIdentity } from './accessPolicy.js';
import { auditEvent } from './audit.js';

type RequestWithSecurityIdentity = FastifyRequest & { securityIdentity?: SecurityIdentity | null };

export function isRoleAllowed(role: Role | undefined, allowed: readonly Role[]): boolean {
  return Boolean(role && hasRole(role, allowed));
}

/**
 * Role enforcement is explicitly opt-in. With RBAC disabled this is a no-op,
 * preserving all existing route behavior.
 */
export function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  allowed: readonly Role[],
  enabled: boolean,
): boolean {
  if (!enabled) return true;

  const identity = (request as RequestWithSecurityIdentity).securityIdentity;
  if (!identity) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  if (!isRoleAllowed(identity.role, allowed)) {
    auditEvent('api-rbac-rejected', { method: request.method, url: request.url, role: identity.role });
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}
