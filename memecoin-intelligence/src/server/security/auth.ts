import crypto from 'node:crypto';

export type Role = 'admin' | 'user';

/**
 * Compare API keys without leaking timing information for equal-length inputs.
 * Different lengths are rejected before calling timingSafeEqual because Node
 * throws when Buffer lengths differ.
 */
export function verifyApiKey(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

export function hasRole(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}
