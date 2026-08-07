const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

async function call<T>(name: string, args: unknown): Promise<T> {
  const response = await fetch(`${API_URL}/api/${name.replace('.', '/')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `API request failed (${response.status})`);
  return payload as T;
}

export function createQueryKey(name: string, args: unknown) { return [name, args] as const; }
export function apiQuery<T>(name: string, args: unknown) {
  return { queryKey: createQueryKey(name, args), queryFn: () => call<T>(name, args) };
}
export function apiMutation(name: string) {
  return { mutationFn: (args: unknown) => call(name, args) };
}
