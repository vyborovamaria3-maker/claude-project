// CLI failures may contain raw JSON/cookies in Error.message or Error.cause.
// Emit only known keyring codes or PostgreSQL SQLSTATE, never arbitrary text.
const KEY_CODES = new Set(['KEY_UNAVAILABLE', 'INVALID_KEY_FORMAT', 'INVALID_KEY_LENGTH',
  'INVALID_KEYRING_JSON', 'INVALID_KEYRING_ENTRY', 'ACTIVE_KEY_UNAVAILABLE',
  'INVALID_ENVELOPE', 'INVALID_KEY_ID', 'DECRYPTION_FAILED']);
export function safeDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return 'OPERATION_FAILED';
  if (KEY_CODES.has(error.message)) return error.message;
  const code = (error as Error & {code?: unknown}).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `PG_${code}` : 'OPERATION_FAILED';
}
