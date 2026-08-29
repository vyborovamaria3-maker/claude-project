import { createHash } from 'node:crypto';
import { verifyApiKey, type Role } from './auth.js';

export type SecurityIdentity = {
  role: Role;
  source: 'legacy' | 'admin' | 'user';
  ownerId: string;
};

function ownerId(providedApiKey: string): string {
  return `key:${createHash('sha256').update(providedApiKey).digest('hex')}`;
}

export type AccessPolicyConfig = {
  rbacEnabled: boolean;
  legacyApiKey?: string;
  adminApiKey?: string;
  userApiKey?: string;
};

export function resolveIdentity(
  providedApiKey: string | undefined,
  config: AccessPolicyConfig,
): SecurityIdentity | null {
  if (!providedApiKey) return null;
  if (verifyApiKey(providedApiKey, config.adminApiKey)) return { role: 'admin', source: 'admin', ownerId: ownerId(providedApiKey) };
  if (verifyApiKey(providedApiKey, config.userApiKey)) return { role: 'user', source: 'user', ownerId: ownerId(providedApiKey) };
  if (verifyApiKey(providedApiKey, config.legacyApiKey)) return { role: 'admin', source: 'legacy', ownerId: ownerId(providedApiKey) };
  return null;
}

/**
 * Compatibility policy:
 * - RBAC disabled + no legacy key => preserve historical public API behavior.
 * - RBAC disabled + legacy key => preserve historical single-key protection.
 * - RBAC enabled => require a recognized legacy/admin/user key.
 */
export function requiresAuthentication(config: AccessPolicyConfig): boolean {
  return config.rbacEnabled || Boolean(config.legacyApiKey);
}
