const memoryState = new Map<string, unknown>();

function isBrowser() {
  return typeof window !== "undefined";
}

export function loadPageState<T>(key: string, fallback: T): T {
  if (memoryState.has(key)) {
    return memoryState.get(key) as T;
  }

  if (!isBrowser()) return fallback;

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    memoryState.set(key, parsed);
    return parsed;
  } catch {
    return fallback;
  }
}

export function savePageState<T>(key: string, value: T) {
  memoryState.set(key, value);

  if (!isBrowser()) return;

  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

export function clearPageState(key: string) {
  memoryState.delete(key);

  if (!isBrowser()) return;

  try {
    window.sessionStorage.removeItem(key);
  } catch {
  }
}
