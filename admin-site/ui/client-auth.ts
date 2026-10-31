// Admin UI uses only its HttpOnly Control Center session. Product JWTs stay server-side.
export function getAccessToken(): null { return null; }
export function authHeaders(extra: HeadersInit = {}): HeadersInit { return new Headers(extra); }
