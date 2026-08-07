import { verifyApiKey, type Role } from './auth.js';

export type SecurityIdentity = {
  role: Role;
  source: 'legacy' | 'admin' | 'user';
};

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
  if (verifyApiKey(providedApiKey, config.adminApiKey)) return { role: 'admin', source: 'admin' };
  if (verifyApiKey(providedApiKey, config.userApiKey)) return { role: 'user', source: 'user' };
  if (verifyApiKey(providedApiKey, config.legacyApiKey)) return { role: 'admin', source: 'legacy' };
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
