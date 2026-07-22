const ACCESS_TOKEN_KEY = "potapoff.access_token";

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function authHeaders(extra: HeadersInit = {}): HeadersInit {
  const headers = new Headers(extra);
  const token = getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}
