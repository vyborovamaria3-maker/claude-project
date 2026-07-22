const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function readCookie(name: string) {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  const csrf = readCookie("csrf_token");
  if (csrf && !headers.has("x-csrf-token")) {
    headers.set("x-csrf-token", csrf);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include"
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}
